# TobenRun 코드 사양서 (기능별)

> 작성일: 2026-06-18 · 엔진: MapleStory Worlds (CoreVersion 26.5.0.0)
> 맵 타입: **MapleTile (TileMapMode = 0)** — 사이드뷰 + 중력 + Foothold, Body = `RigidbodyComponent`

## 0. 게임 개요 & 아키텍처

**TobenRun**은 사이드뷰 러너 액션 게임이다. 플레이어는 오른쪽으로 **자동 주행**하며, **자동 공격**으로 적/장애물에 대응하고, 바닥에서 **솟아오르는 장애물**을 피하거나 부딪히면 **HP**가 깎인다. 스탯(공격력/공격속도)은 데이터 테이블 기반으로 **업그레이드**할 수 있다.

### 서버/클라이언트 권위 원칙
- **서버 권위(ServerOnly)**: 데미지 계산, HP, 스폰, 스탯 레벨, 쿨다운, 자동 공격 판정.
- **클라이언트(ClientOnly)**: HUD 표시, UI 입력, 이펙트 재생.
- **동기화**: `@Sync`(서버→전체 클라), `@TargetUserSync`(서버→해당 유저 클라).

### 전체 컴포넌트 맵
```
[플레이어 엔티티: PlayerCustom (model_id=player_custom, defaultplayer 상속)]
 ├─ script.PlayerController     자동 주행 + 공격 중 전진
 ├─ script.SkillManager         보유 스킬 수집 + 자동 공격 루프(ServerOnly)
 ├─ script.PowerStrike          스킬 로직 (extends SkillComponent) — 검기(SwordBeam) 발사
 ├─ script.PlayerStatManager    스탯 레벨 권위 + 저장
 ├─ script.PlayerHealth         HP/데미지/리스폰
 └─ script.PlayerWallet         메소(화폐) 보유 + 저장  ← 신규

[런타임 스폰: SwordBeam (model_id=SwordBeam, 오브젝트 풀로 재사용)]
 ├─ script.SwordBeam            비행 + 히트 판정 + 재사용(풀링) + OwnerEntity(킬 보상 귀속)
 └─ script.SwordBeamAttack      데미지 판정 (extends AttackComponent)

[맵 엔티티: map01]
 └─ /maps/map01/ObstacleSpawner → script.ObstacleSpawner  장애물 스폰  ← 신규

[배치: NormalMonster (model_id=normalmonster, map01에 배치)]
 └─ script.MonsterUnit          데이터테이블 기반 HP·몸박 데미지·처치 메소  ← 신규

[런타임 스폰: Obstacle (model_id=obstacle, 바디리스)]
 └─ script.Obstacle             솟아오르기 + 접촉 데미지  ← 신규

[전역 로직(@Logic)]
 ├─ script.StatUpgradeUI        스탯 업그레이드 UI (ClientOnly)
 ├─ script.PlayerHudUI          HP 바 HUD (ClientOnly)  ← 신규
 ├─ script.UIPopup              공용 확인 팝업
 └─ script.UIToast              공용 토스트

[데이터] RootDesk/MyDesk/Data/StatTable.(csv|userdataset), MonsterTable.(csv|userdataset)
[UI]    ui/DefaultGroup.ui (공격/점프 버튼, StatPanel, HpBar, 조이스틱, 채팅)
```

---

## 1. 플레이어 이동 — `PlayerController`

| 항목 | 내용 |
|---|---|
| 파일 | `RootDesk/MyDesk/Player/PlayerController.mlua` |
| 타입 | `@Component` (PlayerCustom에 부착) |
| 실행 공간 | 미지정 (호출 측에서 실행 — LocalPlayer는 클라 권위) |

### 프로퍼티
| 이름 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `speed` | number | 2 | 전진 입력값(오른쪽 +X) |
| `movement` | MovementComponent | nil | OnBeginPlay 캐시 |
| `body` | RigidbodyComponent | nil | OnBeginPlay 캐시 |

### 동작
- `OnUpdate`마다 매 프레임:
  1. `movement:MoveToDirection(Vector2(speed,0), delta)` — 이동 + **바라보는 방향** 갱신.
  2. `body.MoveVelocity = Vector2(speed, v.y)` — Rigidbody 이동 입력을 직접 덮어써 **강제 전진**.

### 설계 포인트 (공격 중 전진)
`PlayerControllerComponent`가 자동 추가하는 **`ATTACK` 스테이트는 캐릭터를 정지(rooting)** 시켜 `MoveToDirection`이 무효화된다. `MoveVelocity`를 직접 쓰면 스테이트 머신의 영향을 받지 않으므로, **공격 애니메이션 재생 중에도 주행 속도가 유지**된다. Y 입력은 보존하여 중력/점프에 영향 없음.

---

## 2. 스탯 업그레이드 시스템

데이터 테이블(`StatTable`)을 단일 진실원으로 하는 3계층 구조: **DataSet → PlayerStatManager(서버 권위) → StatUpgradeUI(클라 표시)**.

### 2-1. 데이터 — `StatTable`
| 파일 | `RootDesk/MyDesk/Data/StatTable.csv` (+ `.userdataset`) |
|---|---|

| key | displayName | base | perLevel | maxLevel | cost |
|---|---|---|---|---|---|
| AttackPower | 공격력 | 1.0 | 0.1 | 50 | 100 |
| AttackSpeed | 공격속도 | 1.0 | 0.1 | 30 | 120 |

- 유효값 = `base + perLevel × level`.

### 2-2. `PlayerStatManager` (`@Component`, 서버 권위)
| 파일 | `RootDesk/MyDesk/01_Component/PlayerStatManager.mlua` |
|---|---|

| 프로퍼티 | 타입 | 설명 |
|---|---|---|
| `DataSetName` | string="StatTable" | 읽을 데이터셋 이름 |
| `StorageKey` | string="stat_levels" | DataStorage 저장 키 |
| `StatLevels` | `@TargetUserSync SyncTable<string,number>` | statKey→현재 레벨 (소유 클라에 동기화) |

| 메서드 | 실행공간 | 설명 |
|---|---|---|
| `OnBeginPlay` | ServerOnly | 정의/저장레벨 로드 + 30초 디바운스 저장 타이머 |
| `LoadDefinitions` | ServerOnly | DataSet 전 행 → `defs` 캐시 |
| `LoadLevels` | ServerOnly | UserDataStorage에서 저장 레벨 복원 |
| `GetLevel(key)` | (공통) | 현재 레벨 (동기화 테이블 읽기 → 클라/서버 모두 유효) |
| `GetStatValue(key)` | (서버) | `base + perLevel×level` |
| `RequestUpgrade(key)` | **Server** | 클라(UI)→서버 업그레이드 요청. 소유자/최대레벨 검증 후 레벨++ |
| `Flush(force)` | ServerOnly | 변경분만 DataStorage 저장(크레딧 절약 디바운스) |
| `OnEndPlay` | ServerOnly | 최종 동기 저장 + 타이머 정리 |

### 2-3. `StatUpgradeUI` (`@Logic`, ClientOnly)
| 파일 | `RootDesk/MyDesk/UI/StatUpgradeUI.mlua` |
|---|---|

- DefaultGroup의 `StatPanel` 버튼/텍스트에 UUID 바인딩.
- `btnPowerUp`/`btnSpeedUp` 클릭 → LocalPlayer의 `PlayerStatManager:RequestUpgrade(statKey)` 호출.
- `OnUpdate`에서 동기화된 레벨을 `x<값>  Lv.<n>` / ` MAX` 형식으로 표시.

---

## 3. 스킬 / 공격 시스템

자동 공격 루프(SkillManager) → 스킬(PowerStrike, 검기 발사) → 검기(SwordBeam)의 데미지 판정(SwordBeamAttack)으로 이어진다. 모든 판정은 **서버 권위**.

### 3-1. `SkillComponent` (베이스, `@Component`)
| 파일 | `RootDesk/MyDesk/01_Component/SkillComponent.mlua` |
|---|---|

| 프로퍼티 | 타입 | 설명 |
|---|---|---|
| `SkillName` | string | 스킬 이름 |
| `Cooldown` | number=1.0 | 기본 쿨다운(초) |
| `SpeedStatKey` | string="AttackSpeed" | 쿨다운을 줄이는 스탯 키 |
| `IsReady` | `@Sync boolean` | 사용 가능 여부 |
| `cooldownRemaining` | `@Sync number` | 남은 쿨다운 |
| `statManager` | any | PlayerStatManager 캐시 |

- `GetEffectiveCooldown()` = `Cooldown / AttackSpeed유효값` (하한 0.1).
- `Activate()` → 쿨다운 게이트 통과 시 `IsReady=false`, 쿨다운 세팅, `OnActivate()` 호출(서브클래스 오버라이드).
- `OnUpdate`(ServerOnly): 쿨다운 감소 → 0이면 `IsReady=true`.

### 3-2. `SkillManager` (`@Component`)
| 파일 | `RootDesk/MyDesk/01_Component/SkillManager.mlua` |
|---|---|

- `OnBeginPlay`: 보유 스킬 수집(현재 `PowerStrike`).
- `OnUpdate`(ServerOnly): **자동 공격** — `IsReady`인 스킬을 매 프레임 `Activate()`(쿨다운으로 자체 게이트). 서버에서만 실행 → 쿨다운당 정확히 1회.

### 3-3. `PowerStrike` (`@Component extends SkillComponent`)
| 파일 | `RootDesk/MyDesk/01_Component/PowerStrike.mlua` |
|---|---|

| 주요 프로퍼티 | 기본값 | 설명 |
|---|---|---|
| `Cooldown` | 1.5 | 쿨다운 |
| `PowerStatKey` | "AttackPower" | 데미지 스케일 스탯 |
| `Damage` | 100 | 기본 데미지 |
| `DetectRange` | 6.0 | 이 거리 안 **전방**에 몬스터가 있을 때만 발사(거리 게이트) |
| `StartupDelay` | 1.0 | 플레이 시작 후 이 시간(초) 동안 발사 보류(맵 로딩 대기) |
| `BeamModelId` | "SwordBeam" | 발사할 검기 모델 |
| `BeamForwardOffset/VerticalOffset` | 0.8 / 0.2 | 검기 스폰 오프셋(플레이어 기준) |
| `ParticleScaleX/Y/Z`, `ParticleZRotation` | 1.2/1.2/1 / 0 | 시전 이펙트 스케일/회전 |
| `EffectResourceId` | "88a17d40…" | 시전 이펙트 RUID |

- `OnActivate`(서버): 데미지 = `Damage × AttackPower유효값` 계산 → `FireBeam`이 풀에서 검기(SwordBeam)를 꺼내(`AcquireBeam`) 스폰 위치·방향·데미지를 실어 `Launch` → `PlaySkillEffect`(Multicast)로 전 클라 시전 이펙트.
- `GetFacingDirection`(`LookDirectionX`)로 좌/우 발사 방향 결정.
- 발사 게이트(`ShouldAutoActivate`): ① `OnUpdate`의 시작 그레이스(`StartupDelay`)가 지나야 하고 ② `HasMonsterInRange`로 `DetectRange` 안 전방에 몬스터(`CollisionGroups.HitBox` 비-플레이어)가 있을 때만 발사. → 시작 직후 난사·빈 발사 방지.
- 검기의 비행 속도·수명·히트박스·`AttackInfo`는 **SwordBeam이 단일 진실원으로 소유** — PowerStrike는 스폰 위치/방향/데미지만 전달.

### 3-4. `SwordBeam` / `SwordBeamAttack` (검기 발사체)
| 파일 | `RootDesk/MyDesk/01_Component/SwordBeam.mlua`, `SwordBeamAttack.mlua` |
|---|---|
| 모델 | `RootDesk/MyDesk/Models/Skill/SwordBeam.model` (model_id `SwordBeam`) |

- `SwordBeam`(`@Component`): PowerStrike가 `SpawnByModelId`로 스폰해 **오브젝트 풀**로 재사용(파괴하지 않고 파킹). 비행/히트/수명/맵 이탈을 모두 소유. `Launch`로 위치·방향·데미지만 받고, `OnUpdate`(ServerOnly)에서 이동 → 히트박스(`AttackFrom`) → 피격/수명/맵이탈 시 `Deactivate`(파킹 후 재사용).
- `SwordBeamAttack`(`@Component extends AttackComponent`, 부모와 `@ExecSpace` 미지정 일치 — LEA-3014 방지):
  - `CalcDamage`: `attackInfo == "PowerStrike"`면 `BaseDamage`(런치 시 스탯 반영), 아니면 1.
  - `GetCriticalDamageRate` = `CriticalRate`(1.5), `CalcCritical` = false.
  - `IsAttackTarget`: 자기 자신/`HitComponent` 없는 대상/플레이어 제외(검기가 공격 엔티티이므로 플레이어 제외 명시).
  - `OnAttack`: 로그.

### 3-5. `HitEffectOnHit` (`@Component`)
| 파일 | `RootDesk/MyDesk/HitEffectOnHit.mlua` |
|---|---|

- `HitComponent.EmitHitEvent` 구독 → 피격 시 `_ParticleService:PlayBasicParticle(CircularExplosion, …)` 재생. `ParticleScaleX/Y/Z`, `ParticleZRotation` 조절.

---

## 4. 장애물 시스템 (신규)

바닥 **아래에서 솟아오르는** 가시 함정을 선두 플레이어 앞쪽에 랜덤 생성한다. 모두 서버 권위, 트랜스폼은 클라로 복제.

### 4-1. `ObstacleSpawner` (`@Component`, 맵 엔티티 `ObstacleSpawner`에 부착)
| 파일 | `RootDesk/MyDesk/Obstacle/ObstacleSpawner.mlua` |
|---|---|

| 프로퍼티 | 기본값 | 설명 |
|---|---|---|
| `SpawnIntervalMin/Max` | 1.0 / 2.4 | 스폰 간격 랜덤 범위(초) |
| `SpawnAheadX` | 5.0 | 선두 플레이어로부터 +X 앞 거리 |
| `GroundY` | 0.4 | 다 솟았을 때 장애물 중심 높이 |
| `RiseDepth` | 1.3 | 시작 시 지면 아래 깊이 |
| `MinSpawnX/MaxSpawnX` | -4.0 / 5.2 | 스폰 X 클램프(주행 가능 발판 범위) |
| `ObstacleModelId` | "obstacle" | 스폰 모델 id |

- `OnUpdate`(ServerOnly): 카운트다운 → 0이면 `SpawnObstacle()` + 다음 랜덤 간격.
- `SpawnObstacle`: 맵 내 플레이어 중 **최대 X(선두)** 탐색 → `spawnX = leadX + SpawnAheadX`(클램프) → `(spawnX, GroundY-RiseDepth, 0)`에 `SpawnByModelId` → 스폰된 `Obstacle.TargetY = GroundY` 설정.

### 4-2. `Obstacle` (`@Component`, 바디리스)
| 파일 | `RootDesk/MyDesk/Obstacle/Obstacle.mlua` |
|---|---|

| 프로퍼티 | 기본값 | 설명 |
|---|---|---|
| `TargetY` | 0.4 | 솟아오를 목표 높이(스포너가 설정) |
| `RiseSpeed` | 4.0 | 상승 속도(u/s) |
| `Damage` | 20 | 접촉 데미지 |
| `HitRadius` | 0.6 | 접촉 판정 반경(u) |
| `Lifetime` | 12.0 | 안전 자동 제거 시간 |

- `OnUpdate`(ServerOnly): `TargetY`까지 상승(바디리스 → Transform 직접 쓰기 가능, 클라 복제) → 수명 초과 시 `Despawn` → `CheckHit`.
- `CheckHit`: 맵 내 플레이어 중 `HitRadius` 내 첫 대상의 `PlayerHealth:TakeDamage(Damage)` 호출 후 자기 제거.

### 4-3. `Obstacle.model`
| 파일 | `RootDesk/MyDesk/Models/Obstacles/Obstacle.model` (model_id `obstacle`) |
|---|---|

- 컴포넌트: `TransformComponent` + `SpriteRendererComponent` + `script.Obstacle` (**Body 없음**).
- 값: `SpriteRUID="af921b2251574675834981e2394e05d1"`(가시 함정), `SortingLayer="MapLayer0"`, `OrderInLayer=2`, `Scale=(0.5,0.5,1)`.

---

## 5. HP / 데미지 시스템 (신규)

### 5-1. `PlayerHealth` (`@Component`, PlayerCustom에 부착)
| 파일 | `RootDesk/MyDesk/Player/PlayerHealth.mlua` |
|---|---|

| 프로퍼티 | 타입/기본값 | 설명 |
|---|---|---|
| `MaxHp` | `@Sync number`=100 | 최대 HP |
| `CurrentHp` | `@Sync number`=100 | 현재 HP (HUD가 읽음) |
| `respawnX/respawnY` | number | OnBeginPlay에서 기록한 리스폰 좌표 |
| `invulnTime` | number=0.7 | 피격 후 무적 시간 |
| `invulnRemain` | number | 무적 잔여 |

| 메서드 | 실행공간 | 설명 |
|---|---|---|
| `OnBeginPlay` | ServerOnly | HP 풀 충전 + 현재 월드좌표를 리스폰 지점으로 기록 |
| `OnUpdate` | ServerOnly | 무적 시간 감소 |
| `TakeDamage(amount)` | ServerOnly | 무적/비양수 무시 → HP 감소 → **피격 효과** 재생 → 0 이하면 `Respawn` |
| `Respawn` | ServerOnly | HP 풀 충전 + `MovementComponent:SetWorldPosition`으로 출발점 복귀 |
| `PlayHitEffects(amount)` | Multicast | 전 클라: 머리 위 데미지 숫자(`02c22d93…`) + `SparkExplosion` 파티클 |
| `ShakeCameraOnHit` | Client(피격자) | 피격 플레이어 카메라만 흔들기(`ShakeIntensity`/`ShakeDuration`) |

> 피격 효과는 몬스터 몸박·장애물 등 **모든 `TakeDamage` 경로**에 공통 적용. 데미지 숫자 렌더를 위해 `PlayerCustom.model`에 `DamageSkinSpawnerComponent`+`DamageSkinComponent` 추가.

### 5-2. HP HUD — `PlayerHudUI` + `DefaultGroup.ui`
| 파일 | `RootDesk/MyDesk/UI/PlayerHudUI.mlua` (`@Logic`, ClientOnly) |
|---|---|

- UI: `DefaultGroup`의 좌상단 `HpBar`(Bg/Fill/Label). `Fill`은 `SpriteGUIRendererComponent` Filled(Horizontal), `FillAmount`로 비율 표시.
- 바인딩: `hpFill`→`HpBar/Fill`, `hpLabel`→`HpBar/Label` (UIBuilder가 UUID 주입).
- `OnUpdate`: LocalPlayer의 `PlayerHealth`에서 `CurrentHp/MaxHp` 읽어 `FillAmount = 비율`, 라벨 `"<cur> / <max>"` 갱신.

---

## 5-3. 몬스터 / 메소 시스템 (신규)

데이터테이블(`MonsterTable`)을 단일 진실원으로 하는 데이터 주도 몬스터. 모든 판정 **서버 권위**.

### 데이터 — `MonsterTable`
| 파일 | `RootDesk/MyDesk/Data/MonsterTable.csv` (+ `.userdataset`) |
|---|---|

| id | displayName | maxHp | contactDamage | mesoReward | spriteRUID |
|---|---|---|---|---|---|
| normal | 슬라임 | 50 | 10 | 15 | d4ffccd5… |

- `id`로 행을 찾아(`_DataService:GetTable → FindRow("id", …)`) 스탯을 주입. 새 몬스터(보스 등)는 행 추가만으로 확장.

### `MonsterUnit` (`@Component`, NormalMonster에 부착)
| 파일 | `RootDesk/MyDesk/Monster/MonsterUnit.mlua` |
|---|---|

| 프로퍼티 | 기본값 | 설명 |
|---|---|---|
| `DataSetName` | "MonsterTable" | 읽을 데이터셋 |
| `MonsterId` | "normal" | 테이블 행 키 |
| `MaxHp/Hp` | `@Sync` 50 | 테이블에서 로드 |
| `ContactDamage` | 10 | 몸박 데미지(테이블) |
| `MesoReward` | 15 | 처치 메소(테이블) |
| `ContactRadius` | 0.7 | 접촉 판정 반경 |

- `OnBeginPlay`(ServerOnly): `LoadFromTable`로 HP/몸박/메소/스프라이트 주입 → `Hp = MaxHp`.
- `HandleHitEvent`(`@EventSender("Self")`): 검기 피격 시 `Hp -= TotalDamage` → 0 이하면 `Die(event.AttackerEntity)`.
- `Die`: `GrantMeso` 후 엔티티 제거. `GrantMeso`는 공격자(검기 엔티티)의 `SwordBeam.OwnerEntity`(발사 플레이어)를 찾아 그 플레이어의 `PlayerWallet:AddMeso(MesoReward)` 호출.
- `OnUpdate`(ServerOnly): 몸박 — 반경 내 플레이어에게 `PlayerHealth:TakeDamage(ContactDamage)`(PlayerHealth 무적 0.7s가 연타 방지).

### `NormalMonster.model`
| 파일 | `RootDesk/MyDesk/Models/Monsters/NormalMonster.model` (model_id `normalmonster`) |
|---|---|

- 컴포넌트: `TransformComponent` + `SpriteRendererComponent` + `RigidbodyComponent`(MapleTile) + `MovementComponent`(패트롤) + `StateComponent` + `HitComponent` + `DamageSkinSpawnerComponent` + `DamageSkinComponent` + `script.MonsterUnit`.
- `HitComponent`: `IsLegacy=false`, `BoxSize=(1.2,1.5)`, `ColliderOffset=(0,0.75)`(빔 레인을 덮도록 세로로 큼), **`CollisionGroup`은 미설정 → 기본값 `CollisionGroups.HitBox`**(검기 `AttackFrom(…, CollisionGroups.HitBox)`와 그룹 100% 일치. 하드코딩 UUID는 어긋날 위험이 있어 제거).
- 데미지 숫자(머리 위): **자동 모드** — 빔에 `DamageSkinSettingComponent`(공격자) + 몬스터에 `DamageSkinSpawnerComponent`+`DamageSkinComponent`(피격자). 코드 없이 피격 시 자동 표시.
- `SpriteRUID="d4ffccd5…"`(기본; 테이블이 런타임 덮어씀), `SortingLayer="MapLayer0"`, `OrderInLayer=2`.
- 배치: map01에 `NormalMonster_1`(x=1.5), `NormalMonster_2`(x=8.0), y=0.4.

### `PlayerWallet` (`@Component`, PlayerCustom에 부착)
| 파일 | `RootDesk/MyDesk/Player/PlayerWallet.mlua` |
|---|---|

- `@TargetUserSync number Meso` — 소유 클라에 동기화(향후 메소 HUD용).
- `AddMeso(amount)`(ServerOnly): 메소 가산 + dirty.
- `LoadMeso`/`Flush`/`OnEndPlay`: UserDataStorage 30초 디바운스 저장(크레딧 절약; `PlayerStatManager` 패턴 미러).

---

## 6. 공용 UI 인프라

| 스크립트 | 타입 | 설명 |
|---|---|---|
| `UIPopup` (`RootDesk/MyDesk/UIPopup.mlua`) | `@Logic` | OK/Cancel 확인 팝업. `Open(message, onOk, onCancel)` + 스케일/알파 트윈, 콜백 |
| `UIToast` (`RootDesk/MyDesk/UIToast.mlua`) | `@Logic` | 토스트 메시지. `ShowMessage(message)`(Client) + 페이드/슬라이드 트윈, `duration` 후 자동 숨김 |

> `TestComponent.mlua`는 빈 스텁(미사용).

---

## 7. 맵 / 엔티티 구성 (참고)

| 항목 | 값 |
|---|---|
| 맵 | `map/map01.map`, TileMapMode=0 (MapleTile) |
| 발판 | y≈0.04, x = -4.37 ~ 5.27 (메인 그라운드) + x=6.43~7.97 (y=-1.16 단) |
| 플레이어 스폰 | (-2.23, 0.5) |
| 플레이어 모델 | `PlayerCustom` (model_id `player_custom`, `defaultplayer` 상속) |
| 배치 엔티티 | Background, MapleMapLayer, TileMap, monster-313(chasemonster), monster-61(movemonster), SpawnLocation, **ObstacleSpawner** |

---

## 8. 파일 인덱스

| 기능 | 파일 |
|---|---|
| 이동 | `Player/PlayerController.mlua` |
| HP | `Player/PlayerHealth.mlua` |
| 스탯 | `01_Component/PlayerStatManager.mlua`, `UI/StatUpgradeUI.mlua`, `Data/StatTable.{csv,userdataset}` |
| 스킬/공격 | `01_Component/SkillComponent.mlua`, `SkillManager.mlua`, `PowerStrike.mlua`, `SwordBeam.mlua`, `SwordBeamAttack.mlua`, `Models/Skill/SwordBeam.model` |
| 피격 이펙트 | `HitEffectOnHit.mlua` |
| 몬스터 | `Monster/MonsterUnit.mlua`, `Models/Monsters/NormalMonster.model`, `Data/MonsterTable.{csv,userdataset}` |
| 메소 | `Player/PlayerWallet.mlua` |
| 장애물 | `Obstacle/ObstacleSpawner.mlua`, `Obstacle/Obstacle.mlua`, `Models/Obstacles/Obstacle.model` |
| HUD/UI | `UI/PlayerHudUI.mlua`, `UIPopup.mlua`, `UIToast.mlua`, `ui/DefaultGroup.ui` |

---

## 9. 데이터 흐름 요약

```
[자동 공격] SkillManager.OnUpdate(서버) → PowerStrike.Activate → OnActivate
   → FireBeam: SwordBeam 풀에서 꺼내 Launch(위치/방향/데미지) + PlaySkillEffect(Multicast)
   → SwordBeam.OnUpdate(서버): 비행 + AttackFrom 히트판정 → SwordBeamAttack(데미지)
   → 피격 대상 HitComponent → HitEffectOnHit(파티클)

[몬스터] (배치) NormalMonster.MonsterUnit.OnBeginPlay(서버) → MonsterTable 로드(HP/몸박/메소)
   → 검기 피격: SwordBeam.AttackFrom → SwordBeamAttack(데미지) → MonsterUnit.HandleHitEvent(Hp 감소)
   → Hp 0 → Die → SwordBeam.OwnerEntity의 PlayerWallet.AddMeso(메소) → 엔티티 제거
   → 몸박: MonsterUnit.OnUpdate(서버) 반경 내 플레이어 → PlayerHealth.TakeDamage(몸박)

[장애물] ObstacleSpawner.OnUpdate(서버) → SpawnByModelId(obstacle, 지면 아래)
   → Obstacle.OnUpdate: 상승 + CheckHit → PlayerHealth.TakeDamage
   → CurrentHp(@Sync) → PlayerHudUI.OnUpdate(클라) → HP 바 갱신
   → HP 0 → PlayerHealth.Respawn(출발점 복귀 + HP 충전)

[스탯] StatUpgradeUI(클라 클릭) → PlayerStatManager.RequestUpgrade(Server RPC)
   → StatLevels(@TargetUserSync) → 스킬 데미지/쿨다운 + UI 라벨 반영 → DataStorage 저장
```

# 현단아 얼굴 합성 퀴즈 — OBS 송출 데이터 규격 v2 (v1.3.0)

이 문서는 별도 방송 디자인 채팅에서 화면 스타일을 연결할 때 참고하는 **공개 허용 데이터** 명세입니다. 진행실·문제 관리실의 비공개 자료를 OBS에 직접 넘기지 않습니다.

## 송출 상태

`GET http://127.0.0.1:8765/api/public?rev=<lastRevision>`

응답은 `{ revision, connected, unchanged, state }`이며, `state`는 공개 화면의 정보만 포함합니다. `unchanged=true`인 경우 state가 생략될 수 있습니다. 기존 화면은 `http://127.0.0.1:8765/obs`로 연결합니다.

`state` 주요 필드:

- `version: 2`
- `stage`: `waiting`, `title`, `question`, `reveal`, `emergency` 중 하나
- `round`: 예: `라운드 01`
- `image`: 왼쪽 큰 칸에 출력할 **합성 이미지 또는 공개 중인 원본 이미지**의 PNG data URL
- `hint`: 사용자가 공개한 힌트만 표시
- `focus`: 지금 왼쪽 큰 칸에서 공개 중인 인물 `{slot, name, source, image}` 또는 `null`
- `revealed`: **현재까지 공개한 인물**의 배열. 각 항목 `{slot, name, source, image}`. 순서 A→B→C→D.
- `revealStep`: 정답 공개 단계 0..`2*n`
- `revealTotal`: `2*n` (`n`=현재 참여 인원)

**정답 공개 전(문제 화면)**: `focus: null`, `revealed: []`, `image: 합성 이미지`, 출처·이름 전송 안 함.

**3명 문제 진행 순서**

| 단계 | 왼쪽 큰 사진 (`image`) | `focus` | `revealed` |
|---|---|---|---|
| 0 | ABC 합성 | null | [] |
| 1 | A 원본 | A | [A] |
| 2 | ABC 합성 | null | [A] |
| 3 | B 원본 | B | [A,B] |
| 4 | ABC 합성 | null | [A,B] |
| 5 | C 원본 | C | [A,B,C] |
| 6 | ABC 합성 | null | [A,B,C] |

2명 또는 4명이면 동일 규칙으로 4단계/8단계로 변경합니다. 오른쪽 인물 사진 칸에 공개된 인물의 **위쪽 출처, 아래쪽 이름**을 표시하려면 `revealed[].source` / `.name`을 사용합니다. 아직 공개하지 않은 인물의 원본·이름·출처는 전송되지 않습니다.

방송 디자인/애니메이션은 별도 채팅에서 작업합니다. 데이터 변환은 원본 이미지 레이어의 이동·확대·회전·투명도 합성만 허용하며 생성형 얼굴 합성이나 AI 얼굴 자동 정렬은 사용하지 않습니다.

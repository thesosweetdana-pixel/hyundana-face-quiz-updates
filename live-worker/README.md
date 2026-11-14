# 현단아 뉴뀨? 참가자용 실시간 화면

진행자는 기존 127.0.0.1:8765/studio를 사용하고, 참가자는 Cloudflare Worker의 HTTPS 주소를 열어 **보기만** 합니다. 관리자 화면과 미공개 정답은 배포되지 않습니다.

## Cloudflare 배포
1. Cloudflare 계정에 로그인하고 로컬에서 `npm install -g wrangler` 및 `wrangler login` 실행
2. 퀴즈 로컬 폴더의 `assets/standby.webp`, `intro.webp`, `question.webp`, `answer.webp`, `next.mp4`, `end.webp`를 `live-worker/public/assets/`에 복사하세요. 미복사 시 참가자 페이지는 기본 대체 디자인으로 보입니다.
3. `cd live-worker`, `npx wrangler secret put PUBLISH_TOKEN`에서 **길고 무작위인 비밀키**를 입력하세요. GitHub나 참가자에게 공유하지 마세요.
4. `npx wrangler deploy`로 배포해 출력된 `https://...workers.dev` 주소를 복사하세요.
5. 진행실의 **참가자 실시간 중계 설정**에서 이 주소와 동일한 비밀키를 입력하고 연결 버튼을 누르세요. 참가자에게는 Cloudflare 주소만 공유하세요.

## 주의
- 기존 로컬 IP 주소/8765 포트를 공개하지 마세요.
- 방송 진행실을 연 상태에서만 실시간 동기화가 유지됩니다.
- 공개되는 것은 현재 단계에서 허용된 합성사진과 이미 공개한 원본·이름·출처입니다.
- 참가자 화면은 현재 기본 웹 디자인입니다. OBS와 완전히 같은 시각 디자인은 위 assets 이미지 배포 후 렌더러 연결을 추가 확인해야 합니다.
- 기본 플레이어는 약 1초 간격으로 갱신합니다. 15명 동시 접속·영상 타이밍은 실제 테스트 전까지 보증할 수 없습니다.

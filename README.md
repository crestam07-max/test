# ShareCal

TimeTree 風のスケジュール共有アプリです。家族・友人・チームでカレンダーを共有し、予定の追加や変更がメンバー全員の画面にリアルタイムで反映されます。

## 主な機能

- **アカウント** — メールアドレスとパスワードで登録・ログイン（登録時に個人用カレンダーを自動作成）
- **複数カレンダー** — 「家族」「サークル」など用途ごとに作成し、色を付けて切り替え
- **招待リンクで共有** — リンクを送るだけで参加。オーナーはリンクを再発行して古いリンクを無効化できる
- **予定** — 月表示、終日／時間指定、複数日、ラベル色、場所、メモ
- **コメント** — 予定ごとにメンバー同士でやり取り
- **リアルタイム同期** — Server-Sent Events で他のメンバーの変更が即座に反映され、通知が表示される
- **最近の更新** — 誰が何をしたかのアクティビティ履歴
- **スマホ対応** — レスポンシブ表示

## 起動方法

Node.js 22.13 以上が必要です（組み込みの `node:sqlite` を使用するため、ネイティブモジュールのビルドは不要です）。

```bash
npm install
npm start          # http://localhost:3000
npm test           # API テスト
```

環境変数:

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `DB_FILE` | `data/app.db` | SQLite ファイル（`:memory:` でメモリ上） |

## 構成

```
server/
  index.js   起動スクリプト
  app.js     REST API・認証・リアルタイム配信（Express）
  db.js      SQLite スキーマ
public/      フロントエンド（ビルド不要の HTML / CSS / JS）
test/        node:test による API テスト
```

## API 概要

すべて `Authorization: Bearer <token>` が必要です（登録・ログインを除く）。

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/api/auth/register` `/api/auth/login` `/api/auth/logout` | 認証 |
| GET | `/api/me` | ログイン中のユーザー |
| GET / POST | `/api/calendars` | 参加中のカレンダー一覧／作成 |
| GET / PATCH | `/api/calendars/:id` | 詳細（メンバー含む）／名前・色の変更 |
| POST | `/api/calendars/:id/invite/regenerate` | 招待リンク再発行（オーナーのみ） |
| DELETE | `/api/calendars/:id/members/me` | 退出（最後の1人なら削除） |
| GET | `/api/calendars/:id/activities` | 更新履歴 |
| GET | `/api/invites/:code` / POST `/api/invites/:code/join` | 招待の確認／参加 |
| GET / POST | `/api/calendars/:id/events?from=&to=` | 期間内の予定／作成 |
| GET / PATCH / DELETE | `/api/events/:id` | 予定の取得・更新・削除 |
| GET / POST | `/api/events/:id/comments` | コメント |
| GET | `/api/stream?token=` | リアルタイム通知（SSE） |

## 今後の拡張案

- 週・日表示、繰り返し予定、リマインダー（プッシュ通知）
- メンバーごとの権限（閲覧のみ等）
- 外部カレンダー（Google / iCal）連携
- モバイルアプリ化（PWA または React Native）
- 本番運用向け: HTTPS、セッション有効期限、レート制限、PostgreSQL への移行、複数サーバー時の Pub/Sub

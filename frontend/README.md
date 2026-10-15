# frontend

Containerlabベースのオープンソース版CML（ラボ管理GUI）のフロントエンド。React + React Flow（トポロジエディタ）+ xterm.js（統合コンソール）。詳しい背景・アーキテクチャはリポジトリルートの `CLAUDE.md` / `docs/overview.md` を参照。

## セットアップ

```sh
npm install
npm run dev
```

デフォルトでは `http://localhost:5173` で起動する（Vite標準ポート）。

## 現状

- clab-api-server 未接続のため、`src/mocks/labs.ts` のダミーデータで動作確認している
- API仕様は `docs/api-contract.md`、進捗は `docs/STATUS.md` を参照

## dev-tools について

`../dev-tools/` に、統合コンソール（xterm.js）疎通確認用の簡易WebSocketエコーサーバーがある。バックエンド（clab-api-server）未接続でもコンソール表示だけ先行確認できる。

```sh
cd ../dev-tools
npm install
npm start
```

## Lint

```sh
npm run lint
```

## テスト

```sh
npm test
```

vitest（2026-10-15〜）。トポロジ⇔containerlab YAMLの変換・保存と読み込みの往復・ノードごとの設定コマンド
（`src/utils/labTopology.test.ts`）と、リンクの品質の値の変換（`src/utils/linkCondition.test.ts`）。
イメージのタグを上げた時に古いルーターがPCと判定された不具合（2026-10-15）のような退行を防ぐためのもの。

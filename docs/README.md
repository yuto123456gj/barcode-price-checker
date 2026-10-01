# 単価ウォッチ（スマホ用Webアプリ）

バーコードをかざすだけで価格を判定するアプリ本体。静的ファイルだけなので、
HTTPS で配信できる場所に置けばそのまま動く。

## GitHub Pages で公開する

**カメラは HTTPS でしか動かない。** `http://192.168.x.x` のようなローカルIPでは
ブラウザがカメラを拒否する（`localhost` だけが例外）。GitHub Pages は HTTPS なので問題ない。

1. GitHub で新しいリポジトリを作る（無料プランだと public になる。公開されるのはコードだけで、
   買い物の記録は端末内の localStorage にしか保存しないので外には出ない）
2. このプロジェクトを push する
3. リポジトリの **Settings → Pages** を開く
4. Source を **Deploy from a branch**、Branch を **main** / フォルダを **/docs** にして Save
5. 1〜2分待つと `https://<ユーザー名>.github.io/<リポジトリ名>/` で開ける

スマホでそのURLを開き、共有メニューから「ホーム画面に追加」するとアプリとして起動する。

## Mac で試す

`localhost` は HTTPS でなくてもカメラが使えるので、置き場所を用意する前に試せる。

```bash
cd docs && python3 -m http.server 8000
# → http://localhost:8000 をブラウザで開く
```

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面 |
| `logic.js` | 判定ロジック。`src/` の TypeScript 版と同じ規則で、結果が一致することを確認済み |
| `app.js` | カメラ・保存・描画 |
| `app.css` | スタイル |
| `sw.js` | オフライン用のキャッシュ。売り場で電波が切れても開ける |
| `vendor/zxing.min.js` | バーコード読み取り（[@zxing/library](https://github.com/zxing-js/library) 0.21.3、Apache-2.0） |

## 動作条件

- 読み取りは `BarcodeDetector`（Android Chrome）があればそれを、なければ ZXing を使う。
  iPhone の Safari は `BarcodeDetector` を持たないので ZXing 側で動く
- カメラが使えない場合は「写真」ボタン（撮影した静止画から読み取り）と手入力に逃げられる
- 記録は端末の localStorage。ブラウザのデータを消すと一緒に消える。端末間の同期はしない

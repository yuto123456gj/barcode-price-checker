# barcode-price-checker

バーコード（JANコード）スキャンと価格比較の**バックエンド/比較ロジックモジュール**。
UI やスキャナ実装には依存しない純粋な TypeScript モジュールで、外部APIとDBは
インターフェース経由で差し替えられる。

## セットアップ

```bash
npm install     # 型チェック用の typescript / @types/node のみ
npm test        # node:test (Node のTypeScript型ストリッピングで .ts を直接実行)
npm run typecheck
```

Node.js 22.18 以降が必要（`.ts` の直接実行のため）。ランタイム依存はゼロ。

## ディレクトリ

| パス | 役割 |
| --- | --- |
| [src/types.ts](src/types.ts) | データモデルと全インターフェース定義 |
| [src/core/resolveProduct.ts](src/core/resolveProduct.ts) | 商品特定（ハイブリッド解決ロジック） |
| [src/core/evaluatePrice.ts](src/core/evaluatePrice.ts) | 価格比較・最安値判定 |
| [src/api/searchClients.ts](src/api/searchClients.ts) | Yahoo / 楽天クライアントとフォールバック連鎖 |
| [src/repositories/sqlite.ts](src/repositories/sqlite.ts) | SQLite 永続化（`node:sqlite`、本番向け） |
| [src/repositories/inMemory.ts](src/repositories/inMemory.ts) | インメモリ永続化（テスト・開発用） |
| [src/utils/instoreCode.ts](src/utils/instoreCode.ts) | インストアコードの価格・重量抽出 |
| [src/index.ts](src/index.ts) | 公開API |

## 使い方

アプリ起動時に依存を登録する。

```ts
import {
  configureBarcodeModule,
  createSqliteStore,
  FallbackSearchClient,
  YahooShoppingSearchClient,
  RakutenIchibaSearchClient,
} from './src/index.ts';

const store = createSqliteStore('./data/barcode.db');   // スキーマも自動作成

configureBarcodeModule({
  productRepository: store.productRepository,
  priceHistoryRepository: store.priceHistoryRepository,
  searchClient: new FallbackSearchClient([
    new YahooShoppingSearchClient({ applicationId: process.env.YAHOO_APP_ID! }),
    new RakutenIchibaSearchClient({ applicationId: process.env.RAKUTEN_APP_ID! }),
  ]),
});
```

スキャン画面からの典型的な流れ。

```ts
const scan = await resolveProduct('4901777300446');

if (scan.status === 'REQUIRES_MANUAL_INPUT') {
  // scan.manualInputReason で文言を出し分ける
  //   INSTORE_CODE : 「生鮮食品です。商品名を入力してください」
  //   NOT_FOUND    : 「商品が見つかりません。商品名を入力してください」
  //   API_ERROR    : 「通信に失敗しました。手入力で続けますか？」
  //
  // scan.instore があれば価格・重量フォームの初期値に使える
  //   scan.instore.price  → 498 (円)
  //   scan.instore.weight → 量り売りレイアウト使用時のみ (g)
  const product = await registerManualProduct(scan.scannedCode, { name: userInput });
  scan.product = product;
}

const { evaluation } = await recordScan(scan.product.id, 128, 550, {
  storeName: 'スーパーA',
});
// evaluation.status → 'LOWEST_EVER' など
// PRICE_EVALUATION_LABELS[evaluation.status] → '🎉 過去最安値更新'
```

判定だけして履歴を残さない場合は `evaluatePrice(productId, price, quantity?)`、
JANコードしか手元にない場合は `evaluatePriceByJanCode(janCode, ...)` を使う。

依存注入で使いたい場合はグローバル設定を避け、
`createProductResolver({...})` / `createPriceEvaluator({...})` を直接呼ぶ。

## 商品特定ロジック（resolveProduct）

上から順に評価し、最初に成立したもので確定する。

| 条件 | status | source | 外部API |
| --- | --- | --- | --- |
| 桁数・文字種が不正 | `REQUIRES_MANUAL_INPUT` (`INVALID_CODE`) | `NONE` | 叩かない |
| ローカルDBに商品名つきで存在 | `RESOLVED` | `LOCAL` | 叩かない |
| ローカルDBに下書きのみ存在 | `REQUIRES_MANUAL_INPUT` | `LOCAL` | 叩かない |
| 先頭2桁が `20`〜`29`（インストア） | `REQUIRES_MANUAL_INPUT` (`INSTORE_CODE`) | `INSTORE` | **スキップ** |
| 外部APIがヒット | `RESOLVED` | `EXTERNAL_API` | 呼ぶ |
| 外部APIが該当なし（PB商品など） | `REQUIRES_MANUAL_INPUT` (`NOT_FOUND`) | `NONE` | 呼ぶ |
| 通信エラー・APIエラー | `REQUIRES_MANUAL_INPUT` (`API_ERROR`) | `NONE` | 呼ぶ |

- コードは照合前に空白・ハイフンを除去して正規化する。
- APIで解決できた商品は自動的にローカルDBへ保存し、次回以降はローカルヒットさせる。
  商品名が未確定の下書きは保存しない（`registerManualProduct` で確定させてから保存）。
- `resolveProduct` は例外を投げない。APIの失敗はすべて手動入力フローに倒す。

## 価格判定ロジック（evaluatePrice）

比較指標は、容量が指定されていれば**単価**（price / quantity）、なければ**単純価格**。

| status | 条件 |
| --- | --- |
| `FIRST_SCAN` | 比較可能な履歴が0件 |
| `LOWEST_EVER` | 今回 < 過去最安 |
| `GOOD_DEAL` | 今回 ≤ 平均 × 0.95 |
| `HIGH` | 今回 > 平均 × 1.05 |
| `AVERAGE` | 上記以外（平均の ±5% 以内） |

設計上の判断:

- **単価比較のときは容量不明の履歴を除外する。** 500ml と 2L の総額を混ぜると
  平均が無意味になるため。除外の結果0件になれば `FIRST_SCAN` を返す。
- **最安値と同額は `LOWEST_EVER` にしない**（「更新」ではないため）。多くの場合
  `GOOD_DEAL` になる。
- **境界は仕様どおり閉区間**：平均のちょうど95%は `GOOD_DEAL`、ちょうど105%は `AVERAGE`。
- 単価は小数第4位で丸め、比較は誤差 1e-9 を許容する。`100 / 3` のような割り切れない
  単価で判定がブレないようにするため。
- `differencePercentage` は平均との差（%、小数第1位）。負の値が「平均より安い」。

## 永続化

`ProductRepository` / `PriceHistoryRepository` を実装すれば任意のDBを使える。
標準で2実装を同梱している。

| 実装 | 用途 |
| --- | --- |
| `createSqliteStore(path)` | 本番・ローカル開発。Node 組み込みの `node:sqlite` を使うので追加依存なし |
| `InMemoryProductRepository` ほか | 単体テスト、DBなしの動作確認 |

`createSqliteStore()` は引数なしで `:memory:`、パスを渡すとファイルDB。
初回呼び出しでテーブルとインデックスを作成する（`IF NOT EXISTS` なので再実行可）。

- 日付は ISO8601 文字列、真偽値は 0/1 で保存する（SQLite に専用型がないため）。
- `price_histories.product_id` には外部キー制約 + `ON DELETE CASCADE` を張っている。
- `save()` は id 衝突・jan_code 衝突の両方を UPSERT で扱う。jan_code が既存なら
  **既存行の id と created_at を維持して内容だけ更新する**ので、同じ商品が別IDで
  二重登録されることはない。

## インストアコードの価格・重量抽出

生鮮食品のインストアコードには、商品コードと価格（または重量）が埋め込まれている。

```
2 1 | 0 0 1 2 3 | 0 0 4 9 8 | 5
└2桁┘ └─商品コード─┘ └──価格──┘ └チェックディジット
```

`resolveProduct()` はこれを解析して `result.instore` に返すので、手動入力フォームの
価格欄を埋めた状態で出せる。

```ts
const scan = await resolveProduct('2100123004985');
scan.instore;
// { itemCode: '00123', price: 498, weight: null,
//   canonicalCode: '2100123000009', layoutName: 'JP_PRICE_EMBEDDED_13', ... }
```

### 価格が変わるとバーコードも変わる問題

価格埋め込みコードは**値引きのたびにバーコード文字列そのものが変わる**。
スキャンした文字列を商品キーにすると、同じ豚バラ肉が価格ごとに別商品として登録され、
価格履歴が1件も溜まらず永遠に `FIRST_SCAN` になる。

そこでこのモジュールは、埋め込み部を 0 で潰しチェックディジットを振り直した
**名寄せキー**（`canonicalCode`）を `Product.janCode` として保存する。

```
2100123 00498 5  (498円)  ┐
2100123 00398 6  (398円)  ├→ 2100123 00000 9  として同一商品に名寄せ
2100123 00448 7  (448円)  ┘
```

スキャンした元の文字列は `result.scannedCode` に残る。

### レイアウトの設定

桁割りはチェーンごとに異なるため設定で差し替えられる。既定は価格埋め込み13桁
（`DEFAULT_INSTORE_LAYOUTS`）で、先頭2桁が 20〜29 の13桁コードに適用される。

```ts
configureBarcodeModule({
  // 量り売り（重量埋め込み、0.1g単位）を使う店舗向け
  instoreLayouts: [{ ...JP_WEIGHT_EMBEDDED_13, prefixes: ['26'], valueScale: 0.1 }],
});

configureBarcodeModule({ instoreLayouts: [] });            // 解析を無効化
configureBarcodeModule({ mergeInstoreByItemCode: false }); // 名寄せだけ無効化
```

**注意**: 20〜29 の13桁コードでも、価格を埋め込まず単なる連番PLUとして使う店舗がある。
その場合は既定レイアウトが誤って名寄せし、別商品を1つにまとめてしまう。該当する
プレフィックスを `instoreLayouts` から外すか、`mergeInstoreByItemCode: false` にすること。
重量埋め込みは価格埋め込みと桁割りが同一で機械的に判別できないため、既定では無効。

## 仕様との差分

- 仕様では B の入力が「JANコード」、実装依頼のシグネチャが `evaluatePrice(productId, ...)`
  と食い違っていた。シグネチャ側を正として `productId` で実装し、コード起点の
  `evaluatePriceByJanCode()` を併せて用意した。
- `PriceEvaluationResult` の `lowestUnitPrice` / `averageUnitPrice` /
  `differencePercentage` は `FIRST_SCAN` のとき `null`。0 を返すと「0円が最安」と
  区別できないため。
- 仕様の4項目に加えて `comparisonMode` / `sampleSize` / `lowestRecord` を返している
  （「単価で比較しました」「過去3件中」「最安は店Bでした」と表示するため）。
- 価格埋め込みインストアコードでは `Product.janCode` にスキャン値ではなく名寄せキーが
  入る。スキャン値は `ProductResolutionResult.scannedCode` で参照する。

## テスト

```
node --test 'test/**/*.test.ts'   # 71件
```

- [test/resolveProduct.test.ts](test/resolveProduct.test.ts) — API成功/該当なし/通信エラー/インストア検出/不正コード/ローカルキャッシュ
- [test/evaluatePrice.test.ts](test/evaluatePrice.test.ts) — 5ステータスと境界値、単価 vs 総額、バリデーション
- [test/searchClients.test.ts](test/searchClients.test.ts) — Yahoo/楽天のレスポンス解析、HTTPエラー、フォールバック連鎖
- [test/instoreCode.test.ts](test/instoreCode.test.ts) — 価格/重量の抽出、名寄せキー、レイアウト差し替え
- [test/sqlite.test.ts](test/sqlite.test.ts) — 型の往復、UPSERT、外部キー制約、ファイル永続化
- [test/integration.test.ts](test/integration.test.ts) — スキャン→手動入力→履歴蓄積→判定の通し

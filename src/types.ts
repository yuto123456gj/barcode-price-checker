/**
 * バーコードスキャン & 価格比較モジュールの型定義。
 *
 * 列挙は `enum` ではなく「const オブジェクト + union 型」で表現している。
 * Node の型ストリッピング実行 (`node --test` で .ts を直接実行) は
 * `enum` のようなランタイムを生成する構文を許容しないため。
 */

/* -------------------------------------------------------------------------- */
/* 商品 / 価格履歴                                                             */
/* -------------------------------------------------------------------------- */

/** ローカルDBに保存される商品マスタ。 */
export interface Product {
  /** アプリ内部の一意ID (UUID)。 */
  id: string;
  /** スキャンしたバーコード文字列 (正規化済み)。インストアコードもここに入る。 */
  janCode: string;
  /** 商品名。外部APIまたはユーザーの手動入力で確定する。未確定なら null。 */
  name: string | null;
  /** 商品画像URL。取得できなければ null。 */
  imageUrl: string | null;
  /** インストアコード (先頭2桁が 20〜29) かどうか。 */
  isInstore: boolean;
  /** レコード作成日時。 */
  createdAt: Date;
}

/** 1回のスキャン (= 1店舗・1時点の価格) を表す履歴レコード。 */
export interface PriceHistory {
  id: string;
  /** {@link Product.id} への参照。 */
  productId: string;
  /** 税込価格 (円)。 */
  price: number;
  /** 容量・個数 (例: 500 (ml), 3 (個))。未入力なら null。 */
  unitQuantity: number | null;
  /** 店舗名。未入力なら null。 */
  storeName: string | null;
  scannedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* インストアコード (価格・重量の埋め込み解析)                                 */
/* -------------------------------------------------------------------------- */

/** インストアコードに埋め込まれた値の種別。 */
export const InstoreValueType = {
  /** 価格 (円)。 */
  PRICE: 'PRICE',
  /** 重量 (g)。 */
  WEIGHT: 'WEIGHT',
  /** 個数。 */
  QUANTITY: 'QUANTITY',
} as const;
export type InstoreValueType =
  (typeof InstoreValueType)[keyof typeof InstoreValueType];

/**
 * インストアコードの桁構成。店舗・チェーンごとに異なるため設定で差し替える。
 * 添字はいずれも 0 起点の [開始, 終了) 区間。
 */
export interface InstoreCodeLayout {
  /** レイアウト識別名 (解析結果に含まれる)。 */
  name: string;
  /** 適用対象の先頭2桁 (例: ['20', '21'])。 */
  prefixes: string[];
  /** 対象コードの桁数。 */
  length: number;
  /** 商品コード部の範囲。 */
  itemCode: readonly [number, number];
  /** 埋め込み値 (価格/重量) 部の範囲。 */
  value: readonly [number, number];
  valueType: InstoreValueType;
  /** 最小単位。重量が 0.1g 単位なら 0.1。既定 1。 */
  valueScale?: number;
}

/** インストアコードの解析結果。 */
export interface InstoreCodeInfo {
  /** 一致したレイアウト名。 */
  layoutName: string;
  /** 先頭2桁。 */
  prefix: string;
  /** 店舗内の商品コード。価格が変わっても不変。 */
  itemCode: string;
  /** 埋め込まれた価格 (円)。価格レイアウトでなければ null。 */
  price: number | null;
  /** 埋め込まれた重量 (g)。重量レイアウトでなければ null。 */
  weight: number | null;
  /** 埋め込まれた個数。個数レイアウトでなければ null。 */
  quantity: number | null;
  /**
   * 埋め込み値を 0 で潰し、チェックディジットを振り直した照合用キー。
   * 価格が変わっても同一商品なら同じ値になるので、これを商品の識別子に使う。
   */
  canonicalCode: string;
  /** 解析対象の元コード (正規化済み)。 */
  raw: string;
}

/* -------------------------------------------------------------------------- */
/* 商品特定 (resolveProduct)                                                   */
/* -------------------------------------------------------------------------- */

/** 商品特定の結果ステータス。 */
export const ProductStatus = {
  /** 商品名まで確定した (ローカルDB or 外部APIヒット)。 */
  RESOLVED: 'RESOLVED',
  /** 商品名が取れなかったのでユーザーに手動入力を促す。 */
  REQUIRES_MANUAL_INPUT: 'REQUIRES_MANUAL_INPUT',
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/** 商品情報をどこから取得したか。 */
export const ProductSource = {
  /** ローカルDB / キャッシュ。 */
  LOCAL: 'LOCAL',
  /** 外部API (Yahoo!ショッピング / 楽天など)。 */
  EXTERNAL_API: 'EXTERNAL_API',
  /** インストアコードのため外部問い合わせをスキップ。 */
  INSTORE: 'INSTORE',
  /** 解決できなかった (該当なし / 通信エラー / 不正なコード)。 */
  NONE: 'NONE',
} as const;
export type ProductSource = (typeof ProductSource)[keyof typeof ProductSource];

/** 手動入力が必要になった理由。UI のメッセージ出し分けに使う。 */
export const ManualInputReason = {
  /** インストアコード (生鮮食品など) で外部APIに存在しない。 */
  INSTORE_CODE: 'INSTORE_CODE',
  /** 外部APIは応答したが該当商品なし (PB商品など)。 */
  NOT_FOUND: 'NOT_FOUND',
  /** 通信エラー・タイムアウト・APIエラー。 */
  API_ERROR: 'API_ERROR',
  /** バーコード文字列自体が不正 (桁数・文字種)。 */
  INVALID_CODE: 'INVALID_CODE',
} as const;
export type ManualInputReason =
  (typeof ManualInputReason)[keyof typeof ManualInputReason];

/** {@link resolveProduct} の戻り値。 */
export interface ProductResolutionResult {
  status: ProductStatus;
  source: ProductSource;
  /** 実際にスキャンされたコード (正規化済み)。product.janCode とは異なる場合がある。 */
  scannedCode: string;
  /**
   * 商品情報。
   * status が RESOLVED なら name が入った確定データ。
   * REQUIRES_MANUAL_INPUT の場合は name/imageUrl が null の「初期オブジェクト」。
   */
  product: Product;
  /** ローカルDBに未登録の新規商品か (= この呼び出しで組み立てたか)。 */
  isNew: boolean;
  /** REQUIRES_MANUAL_INPUT のときのみ設定される理由コード。 */
  manualInputReason?: ManualInputReason;
  /** 外部API呼び出し時に発生したエラー (デバッグ/ログ用)。 */
  error?: Error;
  /**
   * インストアコードの解析結果。価格・重量が埋め込まれていた場合のみ。
   * 手動入力フォームの初期値 (価格・容量) に使う。
   */
  instore?: InstoreCodeInfo;
}

/** 外部APIから取得した最低限の商品情報。 */
export interface ExternalProductInfo {
  name: string;
  imageUrl: string | null;
  /** 取得元プロバイダ名 (例: 'yahoo', 'rakuten')。 */
  provider: string;
}

/** 外部商品検索クライアントの共通インターフェース。 */
export interface ProductSearchClient {
  /** プロバイダ識別子。 */
  readonly name: string;
  /**
   * JANコードで商品を検索する。
   * @returns ヒットしなければ null。通信/APIエラーは throw すること。
   */
  searchByJanCode(janCode: string): Promise<ExternalProductInfo | null>;
}

/* -------------------------------------------------------------------------- */
/* 価格判定 (evaluatePrice)                                                    */
/* -------------------------------------------------------------------------- */

/** 価格判定ステータス。 */
export const PriceEvaluationStatus = {
  /** 🎉 過去最安値更新。 */
  LOWEST_EVER: 'LOWEST_EVER',
  /** 👍 お買い得 (平均の5%以上安い)。 */
  GOOD_DEAL: 'GOOD_DEAL',
  /** 😐 通常価格 (平均の±5%以内)。 */
  AVERAGE: 'AVERAGE',
  /** ⚠️ 高め (平均の5%超高い)。 */
  HIGH: 'HIGH',
  /** 🆕 初めてのスキャン (比較対象の履歴なし)。 */
  FIRST_SCAN: 'FIRST_SCAN',
} as const;
export type PriceEvaluationStatus =
  (typeof PriceEvaluationStatus)[keyof typeof PriceEvaluationStatus];

/** UI 表示用のラベル (絵文字つき)。 */
export const PRICE_EVALUATION_LABELS: Record<PriceEvaluationStatus, string> = {
  LOWEST_EVER: '🎉 過去最安値更新',
  GOOD_DEAL: '👍 お買い得',
  AVERAGE: '😐 通常価格',
  HIGH: '⚠️ 高め',
  FIRST_SCAN: '🆕 初めてのスキャン',
};

/** 比較に使った指標。 */
export const ComparisonMode = {
  /** 単価 (price / unitQuantity) で比較した。 */
  UNIT_PRICE: 'UNIT_PRICE',
  /** 単純価格 (price) で比較した。 */
  RAW_PRICE: 'RAW_PRICE',
} as const;
export type ComparisonMode = (typeof ComparisonMode)[keyof typeof ComparisonMode];

/** {@link evaluatePrice} の戻り値。 */
export interface PriceEvaluationResult {
  status: PriceEvaluationStatus;
  /** 今回の比較指標値。容量指定ありなら単価、なしなら価格そのもの。 */
  currentUnitPrice: number;
  /** 過去の最安値 (同一指標)。履歴なしなら null。 */
  lowestUnitPrice: number | null;
  /** 過去の平均値 (同一指標)。履歴なしなら null。 */
  averageUnitPrice: number | null;
  /**
   * 平均との差 (%)。負の値が「平均より安い」。
   * 小数第1位で四捨五入。履歴なしなら null。
   */
  differencePercentage: number | null;
  /** 比較に使った指標。 */
  comparisonMode: ComparisonMode;
  /** 比較対象となった履歴件数。 */
  sampleSize: number;
  /** 過去最安値を記録した履歴 (店舗名の表示用)。履歴なしなら null。 */
  lowestRecord: PriceHistory | null;
}

/** 価格判定のオプション。 */
export interface EvaluatePriceOptions {
  /** 店舗名 (将来の店舗別比較用。判定自体には影響しない)。 */
  storeName?: string;
  /** この日時より前の履歴のみ比較対象にする (既定: 全件)。 */
  since?: Date;
}

/* -------------------------------------------------------------------------- */
/* 永続化層                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProductRepository {
  findByJanCode(janCode: string): Promise<Product | null>;
  findById(productId: string): Promise<Product | null>;
  /** 新規作成または上書き保存。 */
  save(product: Product): Promise<Product>;
}

export interface PriceHistoryRepository {
  findByProductId(productId: string): Promise<PriceHistory[]>;
  add(history: PriceHistory): Promise<PriceHistory>;
}

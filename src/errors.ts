/** モジュール共通のエラー型。 */

/** 外部API呼び出しの失敗 (HTTPエラー / タイムアウト / パース失敗)。 */
export class ExternalApiError extends Error {
  readonly provider: string;
  readonly statusCode: number | undefined;

  constructor(
    provider: string,
    message: string,
    options?: { statusCode?: number; cause?: unknown },
  ) {
    super(`[${provider}] ${message}`, { cause: options?.cause });
    this.name = 'ExternalApiError';
    this.provider = provider;
    this.statusCode = options?.statusCode;
  }
}

/** 引数が不正なとき。 */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

/** 対象の商品がローカルDBに存在しないとき。 */
export class ProductNotFoundError extends Error {
  readonly productId: string;

  constructor(productId: string) {
    super(`商品が見つかりません: ${productId}`);
    this.name = 'ProductNotFoundError';
    this.productId = productId;
  }
}

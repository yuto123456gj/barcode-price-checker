import { ExternalApiError } from '../errors.ts';
import type { ExternalProductInfo, ProductSearchClient } from '../types.ts';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface SearchClientOptions {
  /** APIキー (Yahoo: appid / 楽天: applicationId)。 */
  applicationId: string;
  /** タイムアウト (ms)。既定 5000。 */
  timeoutMs?: number;
  /** fetch 実装。テストでの差し替え用。 */
  fetchImpl?: typeof fetch;
}

/** 共通の fetch + JSON パース。失敗はすべて ExternalApiError に包む。 */
async function fetchJson(
  provider: string,
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    throw new ExternalApiError(provider, '通信に失敗しました', { cause });
  }

  if (!response.ok) {
    throw new ExternalApiError(
      provider,
      `APIがエラーを返しました (HTTP ${response.status})`,
      { statusCode: response.status },
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new ExternalApiError(provider, 'レスポンスの解析に失敗しました', {
      cause,
    });
  }
}

/**
 * Yahoo!ショッピング 商品検索API (v3)。
 * JANコードで直接引けるため第一候補にする。
 */
export class YahooShoppingSearchClient implements ProductSearchClient {
  readonly name = 'yahoo';
  private readonly applicationId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SearchClientOptions) {
    this.applicationId = options.applicationId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchByJanCode(janCode: string): Promise<ExternalProductInfo | null> {
    const url =
      'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch' +
      `?appid=${encodeURIComponent(this.applicationId)}` +
      `&jan_code=${encodeURIComponent(janCode)}&results=1`;

    const body = (await fetchJson(this.name, url, this.timeoutMs, this.fetchImpl)) as {
      hits?: { name?: string; image?: { medium?: string; small?: string } }[];
    };

    const hit = body?.hits?.[0];
    if (!hit?.name) return null;

    return {
      name: hit.name,
      imageUrl: hit.image?.medium ?? hit.image?.small ?? null,
      provider: this.name,
    };
  }
}

/**
 * 楽天市場 商品検索API。
 * JANコード専用パラメータがないのでキーワード検索で代用する。
 */
export class RakutenIchibaSearchClient implements ProductSearchClient {
  readonly name = 'rakuten';
  private readonly applicationId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SearchClientOptions) {
    this.applicationId = options.applicationId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchByJanCode(janCode: string): Promise<ExternalProductInfo | null> {
    const url =
      'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601' +
      `?applicationId=${encodeURIComponent(this.applicationId)}` +
      `&keyword=${encodeURIComponent(janCode)}&hits=1&format=json`;

    const body = (await fetchJson(this.name, url, this.timeoutMs, this.fetchImpl)) as {
      Items?: {
        Item?: { itemName?: string; mediumImageUrls?: { imageUrl?: string }[] };
      }[];
    };

    const item = body?.Items?.[0]?.Item;
    if (!item?.itemName) return null;

    return {
      name: item.itemName,
      imageUrl: item.mediumImageUrls?.[0]?.imageUrl ?? null,
      provider: this.name,
    };
  }
}

/**
 * 複数プロバイダを順に試すフォールバック連鎖。
 *
 * - ヒットした時点で打ち切る
 * - 個別プロバイダのエラーは握り潰して次を試す
 * - 全滅した場合、1件でもエラーがあればエラーを throw (= API_ERROR 扱い)、
 *   全て「該当なし」なら null を返す (= NOT_FOUND 扱い)
 */
export class FallbackSearchClient implements ProductSearchClient {
  readonly name: string;
  private readonly clients: ProductSearchClient[];
  private readonly onError: ((error: unknown, client: ProductSearchClient) => void) | undefined;

  constructor(
    clients: ProductSearchClient[],
    options: { onError?: (error: unknown, client: ProductSearchClient) => void } = {},
  ) {
    this.clients = clients;
    this.name = clients.map((client) => client.name).join('+') || 'none';
    this.onError = options.onError;
  }

  async searchByJanCode(janCode: string): Promise<ExternalProductInfo | null> {
    let lastError: unknown = null;

    for (const client of this.clients) {
      try {
        const result = await client.searchByJanCode(janCode);
        if (result) return result;
      } catch (error) {
        lastError = error;
        this.onError?.(error, client);
      }
    }

    if (lastError) throw lastError;
    return null;
  }
}

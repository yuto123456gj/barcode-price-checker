import { ExternalApiError } from '../errors.ts';
import {
  ManualInputReason,
  ProductSource,
  ProductStatus,
  type InstoreCodeInfo,
  type InstoreCodeLayout,
  type Product,
  type ProductRepository,
  type ProductResolutionResult,
  type ProductSearchClient,
} from '../types.ts';
import {
  DEFAULT_INSTORE_LAYOUTS,
  parseInstoreCode,
} from '../utils/instoreCode.ts';
import { isInstoreCode, isValidBarcode, normalizeCode } from '../utils/janCode.ts';

export interface ProductResolverDeps {
  productRepository: ProductRepository;
  /**
   * 外部商品検索クライアント。
   * 未設定の場合、通常JANコードは常に手動入力へ回る。
   */
  searchClient?: ProductSearchClient | undefined;
  /** 外部APIで解決できた商品をローカルDBに保存するか (既定: true)。 */
  persistResolved?: boolean;
  /**
   * インストアコードの桁構成。既定は価格埋め込み13桁のみ
   * ({@link DEFAULT_INSTORE_LAYOUTS})。空配列を渡すと解析を無効化できる。
   */
  instoreLayouts?: InstoreCodeLayout[];
  /**
   * 価格埋め込みインストアコードを、埋め込み部を潰したキーで名寄せするか
   * (既定: true)。false にするとスキャンした文字列そのものを商品キーにする。
   */
  mergeInstoreByItemCode?: boolean;
  /** 現在時刻の供給元。テストで固定するために差し替える。 */
  now?: () => Date;
  /** ID生成器。 */
  generateId?: () => string;
}

export interface ProductResolver {
  /** バーコードから商品を特定する。 */
  resolveProduct(janCode: string): Promise<ProductResolutionResult>;
  /**
   * 手動入力された商品名でローカルDBに確定登録する。
   * REQUIRES_MANUAL_INPUT を受けた UI からの続きの処理。
   */
  registerManualProduct(
    janCode: string,
    input: { name: string; imageUrl?: string | null },
  ): Promise<Product>;
  /**
   * スキャンしたコードから、DB照合に使うキーを返す。
   * 価格埋め込みインストアコードでは埋め込み部を潰したキーになる。
   */
  toLookupKey(janCode: string): string;
}

/**
 * 商品特定ロジックを組み立てる。
 *
 * 解決の優先順位:
 *   1. ローカルDB / キャッシュ
 *   2. インストアコード (20〜29) → 外部APIをスキップして手動入力へ
 *      (価格・重量が埋め込まれていれば抽出して手動入力の初期値にする)
 *   3. 外部API (Yahoo → 楽天のフォールバック連鎖)
 *   4. 失敗 → 手動入力へ
 */
export function createProductResolver(deps: ProductResolverDeps): ProductResolver {
  const {
    productRepository,
    searchClient,
    persistResolved = true,
    instoreLayouts = DEFAULT_INSTORE_LAYOUTS,
    mergeInstoreByItemCode = true,
    now = () => new Date(),
    generateId = () => crypto.randomUUID(),
  } = deps;

  /** スキャン文字列を、解析結果と照合キーに分解する。 */
  function inspect(rawCode: string): {
    scannedCode: string;
    lookupKey: string;
    instore: InstoreCodeInfo | null;
  } {
    const scannedCode = normalizeCode(rawCode);
    const instore = parseInstoreCode(scannedCode, instoreLayouts);
    const lookupKey =
      instore && mergeInstoreByItemCode ? instore.canonicalCode : scannedCode;
    return { scannedCode, lookupKey, instore };
  }

  /** 未確定の商品オブジェクト (name/imageUrl が null の器) を作る。 */
  function createDraft(janCode: string, isInstore: boolean): Product {
    return {
      id: generateId(),
      janCode,
      name: null,
      imageUrl: null,
      isInstore,
      createdAt: now(),
    };
  }

  function needsManualInput(
    product: Product,
    source: ProductSource,
    reason: ManualInputReason,
    extra: {
      isNew: boolean;
      scannedCode: string;
      instore?: InstoreCodeInfo | null;
      error?: Error;
    },
  ): ProductResolutionResult {
    return {
      status: ProductStatus.REQUIRES_MANUAL_INPUT,
      source,
      scannedCode: extra.scannedCode,
      product,
      isNew: extra.isNew,
      manualInputReason: reason,
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.instore ? { instore: extra.instore } : {}),
    };
  }

  async function resolveProduct(rawCode: string): Promise<ProductResolutionResult> {
    const { scannedCode, lookupKey, instore } = inspect(rawCode);

    // 0. 明らかに不正なコードは外部APIを叩かずに手動入力へ。
    if (!isValidBarcode(scannedCode)) {
      return needsManualInput(
        createDraft(scannedCode, false),
        ProductSource.NONE,
        ManualInputReason.INVALID_CODE,
        { isNew: true, scannedCode },
      );
    }

    // 1. ローカルDB / キャッシュ。
    const cached = await productRepository.findByJanCode(lookupKey);
    if (cached) {
      // 保存済みでも名前が未確定 (インストア商品の下書き等) なら手動入力を促す。
      if (!cached.name) {
        return needsManualInput(
          cached,
          ProductSource.LOCAL,
          cached.isInstore
            ? ManualInputReason.INSTORE_CODE
            : ManualInputReason.NOT_FOUND,
          { isNew: false, scannedCode, instore },
        );
      }
      return {
        status: ProductStatus.RESOLVED,
        source: ProductSource.LOCAL,
        scannedCode,
        product: cached,
        isNew: false,
        ...(instore ? { instore } : {}),
      };
    }

    // 2. インストアコード (生鮮食品など) は外部APIに存在しないのでスキップ。
    //    価格・重量が埋め込まれていれば抽出し、手動入力の初期値として返す。
    if (isInstoreCode(scannedCode)) {
      return needsManualInput(
        createDraft(lookupKey, true),
        ProductSource.INSTORE,
        ManualInputReason.INSTORE_CODE,
        { isNew: true, scannedCode, instore },
      );
    }

    // 3. 通常のJANコード → 外部API。
    const draft = createDraft(scannedCode, false);

    if (!searchClient) {
      return needsManualInput(
        draft,
        ProductSource.NONE,
        ManualInputReason.API_ERROR,
        {
          isNew: true,
          scannedCode,
          error: new ExternalApiError('none', '検索クライアントが未設定です'),
        },
      );
    }

    let found;
    try {
      found = await searchClient.searchByJanCode(scannedCode);
    } catch (cause) {
      // 通信エラー / APIエラー → ユーザーに手動入力を促す。
      return needsManualInput(draft, ProductSource.NONE, ManualInputReason.API_ERROR, {
        isNew: true,
        scannedCode,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }

    // 該当なし (PB商品など)。
    if (!found) {
      return needsManualInput(draft, ProductSource.NONE, ManualInputReason.NOT_FOUND, {
        isNew: true,
        scannedCode,
      });
    }

    const resolved: Product = {
      ...draft,
      name: found.name,
      imageUrl: found.imageUrl,
    };
    const product = persistResolved
      ? await productRepository.save(resolved)
      : resolved;

    return {
      status: ProductStatus.RESOLVED,
      source: ProductSource.EXTERNAL_API,
      scannedCode,
      product,
      isNew: true,
    };
  }

  async function registerManualProduct(
    rawCode: string,
    input: { name: string; imageUrl?: string | null },
  ): Promise<Product> {
    const { lookupKey } = inspect(rawCode);
    const existing = await productRepository.findByJanCode(lookupKey);
    const product: Product = existing
      ? { ...existing, name: input.name, imageUrl: input.imageUrl ?? existing.imageUrl }
      : {
          ...createDraft(lookupKey, isInstoreCode(lookupKey)),
          name: input.name,
          imageUrl: input.imageUrl ?? null,
        };
    return productRepository.save(product);
  }

  return {
    resolveProduct,
    registerManualProduct,
    toLookupKey: (rawCode: string) => inspect(rawCode).lookupKey,
  };
}

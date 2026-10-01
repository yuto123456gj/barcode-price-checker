import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { createProductResolver } from '../src/core/resolveProduct.ts';
import { ExternalApiError } from '../src/errors.ts';
import { InMemoryProductRepository } from '../src/repositories/inMemory.ts';
import {
  ManualInputReason,
  ProductSource,
  ProductStatus,
  type ExternalProductInfo,
  type Product,
} from '../src/types.ts';
import { toLookupKey } from '../src/utils/instoreCode.ts';
import { StubSearchClient, makeProduct } from './helpers.ts';

const JAN = '4901777300446'; // 通常のJANコード
const INSTORE = '2100123004567'; // 先頭2桁が21 = インストアコード
const PB_JAN = '4549741000000'; // 外部APIでヒットしないPB商品を想定

type SearchHandler = (janCode: string) => Promise<ExternalProductInfo | null>;

function setup(handler: SearchHandler, seed: Product[] = []) {
  const productRepository = new InMemoryProductRepository(seed);
  const searchClient = new StubSearchClient(handler);
  const resolver = createProductResolver({ productRepository, searchClient });
  return { productRepository, searchClient, resolver };
}

describe('resolveProduct', () => {
  describe('ローカルDBヒット', () => {
    it('保存済み商品をAPIを叩かずに返す', async () => {
      const saved = makeProduct({ janCode: JAN, name: 'コカ・コーラ 500ml' });
      const { resolver, searchClient } = setup(async () => {
        throw new Error('呼ばれてはいけない');
      }, [saved]);

      const result = await resolver.resolveProduct(JAN);

      assert.equal(result.status, ProductStatus.RESOLVED);
      assert.equal(result.source, ProductSource.LOCAL);
      assert.equal(result.product.name, 'コカ・コーラ 500ml');
      assert.equal(result.isNew, false);
      assert.deepEqual(searchClient.calls, []);
    });

    it('ハイフン・空白入りのコードを正規化して照合する', async () => {
      const saved = makeProduct({ janCode: JAN, name: '保存済み' });
      const { resolver } = setup(async () => null, [saved]);

      const result = await resolver.resolveProduct(' 4901777-300446 ');

      assert.equal(result.status, ProductStatus.RESOLVED);
      assert.equal(result.source, ProductSource.LOCAL);
    });

    it('保存済みでも商品名が未確定なら手動入力を促す', async () => {
      // インストア商品は名寄せキー (埋め込み価格を潰したコード) で保存される。
      const draft = makeProduct({
        janCode: toLookupKey(INSTORE),
        name: null,
        isInstore: true,
      });
      const { resolver, searchClient } = setup(async () => null, [draft]);

      const result = await resolver.resolveProduct(INSTORE);

      assert.equal(result.status, ProductStatus.REQUIRES_MANUAL_INPUT);
      assert.equal(result.manualInputReason, ManualInputReason.INSTORE_CODE);
      assert.equal(result.isNew, false);
      assert.deepEqual(searchClient.calls, []);
    });
  });

  describe('インストアコード検出', () => {
    it('外部APIをスキップして isInstore: true の初期オブジェクトを返す', async () => {
      const { resolver, searchClient } = setup(async () => {
        throw new Error('インストアコードでAPIを呼んではいけない');
      });

      const result = await resolver.resolveProduct(INSTORE);

      assert.equal(result.status, ProductStatus.REQUIRES_MANUAL_INPUT);
      assert.equal(result.source, ProductSource.INSTORE);
      assert.equal(result.manualInputReason, ManualInputReason.INSTORE_CODE);
      assert.equal(result.product.isInstore, true);
      assert.equal(result.product.name, null);
      assert.equal(result.scannedCode, INSTORE, 'スキャン値はそのまま返す');
      assert.equal(
        result.product.janCode,
        toLookupKey(INSTORE),
        '商品側は埋め込み価格を潰した名寄せキーで持つ',
      );
      assert.equal(result.isNew, true);
      assert.deepEqual(searchClient.calls, [], 'APIは一度も呼ばれない');
    });

    it('先頭2桁 20〜29 をすべてインストア扱いにし、19/30 は通常JAN扱いにする', async () => {
      for (const prefix of ['20', '25', '29']) {
        const { resolver, searchClient } = setup(async () => null);
        const result = await resolver.resolveProduct(`${prefix}00000000000`);
        assert.equal(result.product.isInstore, true, `${prefix} はインストア`);
        assert.deepEqual(searchClient.calls, []);
      }
      for (const prefix of ['19', '30', '49']) {
        const { resolver, searchClient } = setup(async () => null);
        const result = await resolver.resolveProduct(`${prefix}00000000000`);
        assert.equal(result.product.isInstore, false, `${prefix} は通常JAN`);
        assert.equal(searchClient.calls.length, 1, 'APIが呼ばれる');
      }
    });
  });

  describe('外部API', () => {
    it('成功時は商品名・画像URLをセットして RESOLVED を返す', async () => {
      const { resolver, productRepository, searchClient } = setup(async () => ({
        name: 'サントリー 天然水 550ml',
        imageUrl: 'https://example.com/item.jpg',
        provider: 'yahoo',
      }));

      const result = await resolver.resolveProduct(JAN);

      assert.equal(result.status, ProductStatus.RESOLVED);
      assert.equal(result.source, ProductSource.EXTERNAL_API);
      assert.equal(result.product.name, 'サントリー 天然水 550ml');
      assert.equal(result.product.imageUrl, 'https://example.com/item.jpg');
      assert.equal(result.product.isInstore, false);
      assert.equal(result.isNew, true);
      assert.deepEqual(searchClient.calls, [JAN]);

      // 次回以降はローカルヒットになるよう保存されている。
      const stored = await productRepository.findByJanCode(JAN);
      assert.equal(stored?.name, 'サントリー 天然水 550ml');
    });

    it('該当なし (PB商品) は NOT_FOUND で手動入力を促す', async () => {
      const { resolver, productRepository } = setup(async () => null);

      const result = await resolver.resolveProduct(PB_JAN);

      assert.equal(result.status, ProductStatus.REQUIRES_MANUAL_INPUT);
      assert.equal(result.manualInputReason, ManualInputReason.NOT_FOUND);
      assert.equal(result.source, ProductSource.NONE);
      assert.equal(result.product.name, null);
      assert.equal(
        productRepository.size,
        0,
        '名前未確定の商品は勝手に保存しない',
      );
    });

    it('通信エラーは API_ERROR で手動入力を促し、エラーを添える', async () => {
      const { resolver } = setup(async () => {
        throw new ExternalApiError('yahoo', '通信に失敗しました');
      });

      const result = await resolver.resolveProduct(JAN);

      assert.equal(result.status, ProductStatus.REQUIRES_MANUAL_INPUT);
      assert.equal(result.manualInputReason, ManualInputReason.API_ERROR);
      assert.ok(result.error instanceof ExternalApiError);
    });

    it('検索クライアント未設定でも例外を投げず手動入力に倒す', async () => {
      const resolver = createProductResolver({
        productRepository: new InMemoryProductRepository(),
      });

      const result = await resolver.resolveProduct(JAN);

      assert.equal(result.status, ProductStatus.REQUIRES_MANUAL_INPUT);
      assert.equal(result.manualInputReason, ManualInputReason.API_ERROR);
    });
  });

  describe('不正なコード', () => {
    it('桁数・文字種が不正なら外部APIを叩かず INVALID_CODE を返す', async () => {
      for (const code of ['', '123', 'abcdefghijklm', '49017773004461234']) {
        const { resolver, searchClient } = setup(async () => null);
        const result = await resolver.resolveProduct(code);
        assert.equal(result.status, ProductStatus.REQUIRES_MANUAL_INPUT, code);
        assert.equal(result.manualInputReason, ManualInputReason.INVALID_CODE, code);
        assert.deepEqual(searchClient.calls, [], code);
      }
    });
  });

  describe('registerManualProduct', () => {
    let repo: InMemoryProductRepository;

    beforeEach(() => {
      repo = new InMemoryProductRepository();
    });

    it('手動入力した商品名を保存し、次回はローカルヒットする', async () => {
      const resolver = createProductResolver({
        productRepository: repo,
        searchClient: new StubSearchClient(async () => null),
      });

      await resolver.resolveProduct(INSTORE);
      const saved = await resolver.registerManualProduct(INSTORE, {
        name: '国産豚バラ肉',
      });

      assert.equal(saved.name, '国産豚バラ肉');
      assert.equal(saved.isInstore, true);

      const again = await resolver.resolveProduct(INSTORE);
      assert.equal(again.status, ProductStatus.RESOLVED);
      assert.equal(again.source, ProductSource.LOCAL);
      assert.equal(again.product.id, saved.id);
    });
  });
});

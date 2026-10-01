import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FallbackSearchClient,
  RakutenIchibaSearchClient,
  YahooShoppingSearchClient,
} from '../src/api/searchClients.ts';
import { ExternalApiError } from '../src/errors.ts';
import type { ExternalProductInfo, ProductSearchClient } from '../src/types.ts';
import { StubSearchClient } from './helpers.ts';

const JAN = '4901777300446';

/** 固定のJSONを返す fetch スタブ。 */
function jsonFetch(body: unknown, init: { status?: number } = {}): typeof fetch {
  return (async (url: string | URL | Request) => {
    void url;
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('YahooShoppingSearchClient', () => {
  it('hits の先頭から商品名と画像URLを取り出す', async () => {
    const client = new YahooShoppingSearchClient({
      applicationId: 'test-appid',
      fetchImpl: jsonFetch({
        hits: [{ name: 'コカ・コーラ 500ml', image: { medium: 'https://img/m.jpg' } }],
      }),
    });

    const result = await client.searchByJanCode(JAN);

    assert.deepEqual(result, {
      name: 'コカ・コーラ 500ml',
      imageUrl: 'https://img/m.jpg',
      provider: 'yahoo',
    });
  });

  it('リクエストURLに jan_code と appid を含める', async () => {
    let requested = '';
    const client = new YahooShoppingSearchClient({
      applicationId: 'test-appid',
      fetchImpl: (async (url: string | URL | Request) => {
        requested = String(url);
        return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      }) as typeof fetch,
    });

    await client.searchByJanCode(JAN);

    assert.match(requested, /jan_code=4901777300446/);
    assert.match(requested, /appid=test-appid/);
  });

  it('hits が空なら null (該当なし)', async () => {
    const client = new YahooShoppingSearchClient({
      applicationId: 'x',
      fetchImpl: jsonFetch({ hits: [] }),
    });

    assert.equal(await client.searchByJanCode(JAN), null);
  });

  it('HTTPエラーは ExternalApiError', async () => {
    const client = new YahooShoppingSearchClient({
      applicationId: 'x',
      fetchImpl: jsonFetch({}, { status: 503 }),
    });

    await assert.rejects(() => client.searchByJanCode(JAN), (error: unknown) => {
      assert.ok(error instanceof ExternalApiError);
      assert.equal(error.statusCode, 503);
      return true;
    });
  });

  it('通信エラーも ExternalApiError に包む', async () => {
    const client = new YahooShoppingSearchClient({
      applicationId: 'x',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });

    await assert.rejects(() => client.searchByJanCode(JAN), ExternalApiError);
  });
});

describe('RakutenIchibaSearchClient', () => {
  it('Items[0].Item から商品名と画像URLを取り出す', async () => {
    const client = new RakutenIchibaSearchClient({
      applicationId: 'x',
      fetchImpl: jsonFetch({
        Items: [
          {
            Item: {
              itemName: 'トップバリュ 天然水 2L',
              mediumImageUrls: [{ imageUrl: 'https://img/r.jpg' }],
            },
          },
        ],
      }),
    });

    const result = await client.searchByJanCode(JAN);

    assert.equal(result?.name, 'トップバリュ 天然水 2L');
    assert.equal(result?.imageUrl, 'https://img/r.jpg');
    assert.equal(result?.provider, 'rakuten');
  });

  it('Items が空なら null', async () => {
    const client = new RakutenIchibaSearchClient({
      applicationId: 'x',
      fetchImpl: jsonFetch({ Items: [] }),
    });

    assert.equal(await client.searchByJanCode(JAN), null);
  });
});

describe('FallbackSearchClient', () => {
  const hit: ExternalProductInfo = {
    name: 'ヒット商品',
    imageUrl: null,
    provider: 'rakuten',
  };

  it('先頭がヒットしたら後続を呼ばない', async () => {
    const first = new StubSearchClient(async () => hit, 'yahoo');
    const second = new StubSearchClient(async () => hit, 'rakuten');

    const result = await new FallbackSearchClient([first, second]).searchByJanCode(JAN);

    assert.equal(result?.name, 'ヒット商品');
    assert.equal(second.calls.length, 0);
  });

  it('先頭が該当なしなら次のプロバイダを試す', async () => {
    const first = new StubSearchClient(async () => null, 'yahoo');
    const second = new StubSearchClient(async () => hit, 'rakuten');

    const result = await new FallbackSearchClient([first, second]).searchByJanCode(JAN);

    assert.equal(result?.provider, 'rakuten');
    assert.equal(second.calls.length, 1);
  });

  it('先頭がエラーでも次で回復できる', async () => {
    const errors: string[] = [];
    const first = new StubSearchClient(async () => {
      throw new ExternalApiError('yahoo', 'down');
    }, 'yahoo');
    const second = new StubSearchClient(async () => hit, 'rakuten');

    const client = new FallbackSearchClient([first, second], {
      onError: (_error, failed: ProductSearchClient) => errors.push(failed.name),
    });
    const result = await client.searchByJanCode(JAN);

    assert.equal(result?.provider, 'rakuten');
    assert.deepEqual(errors, ['yahoo']);
  });

  it('全滅かつエラーありなら throw (= API_ERROR 扱い)', async () => {
    const client = new FallbackSearchClient([
      new StubSearchClient(async () => null, 'yahoo'),
      new StubSearchClient(async () => {
        throw new ExternalApiError('rakuten', 'down');
      }, 'rakuten'),
    ]);

    await assert.rejects(() => client.searchByJanCode(JAN), ExternalApiError);
  });

  it('全滅かつ全て該当なしなら null (= NOT_FOUND 扱い)', async () => {
    const client = new FallbackSearchClient([
      new StubSearchClient(async () => null, 'yahoo'),
      new StubSearchClient(async () => null, 'rakuten'),
    ]);

    assert.equal(await client.searchByJanCode(JAN), null);
  });
});

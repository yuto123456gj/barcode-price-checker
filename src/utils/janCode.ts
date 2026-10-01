/** バーコード文字列の正規化・種別判定。 */

/** インストアコードとみなす先頭2桁の範囲。 */
const INSTORE_PREFIX_MIN = 20;
const INSTORE_PREFIX_MAX = 29;

/** 許容する桁数 (JAN-8 / JAN-13。インストアコードも13桁が一般的)。 */
const VALID_LENGTHS = new Set([8, 12, 13]);

/**
 * 空白・ハイフンを除去する。スキャナやコピペ由来の揺れを吸収する。
 */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '');
}

/** 数字のみ、かつ桁数が JAN として妥当かどうか。 */
export function isValidBarcode(code: string): boolean {
  const normalized = normalizeCode(code);
  return /^\d+$/.test(normalized) && VALID_LENGTHS.has(normalized.length);
}

/**
 * インストアコード (店舗内で採番される生鮮食品等のコード) かどうか。
 * 先頭2桁が 20〜29 のものを対象とする。
 */
export function isInstoreCode(code: string): boolean {
  const normalized = normalizeCode(code);
  if (normalized.length < 2 || !/^\d{2}/.test(normalized)) return false;
  const prefix = Number(normalized.slice(0, 2));
  return prefix >= INSTORE_PREFIX_MIN && prefix <= INSTORE_PREFIX_MAX;
}

/**
 * チェックディジットを除いた本体部分から、JAN (EAN) のチェックディジットを計算する。
 * 右端から交互に 3, 1 の重みを掛けて合計し、10の補数をとる。
 *
 * @param body チェックディジットを含まない数字列 (例: 13桁コードなら先頭12桁)
 */
export function computeCheckDigit(body: string): number {
  const sum = [...body]
    .map(Number)
    .reverse()
    .reduce((acc, digit, index) => acc + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

/**
 * JAN (EAN) のチェックディジットを検証する。
 * 参考情報であり、resolveProduct の分岐には使っていない
 * (読み取り精度の低い環境で正当なコードを弾かないため)。
 */
export function hasValidCheckDigit(code: string): boolean {
  const normalized = normalizeCode(code);
  if (!/^\d+$/.test(normalized) || !VALID_LENGTHS.has(normalized.length)) {
    return false;
  }
  const body = normalized.slice(0, -1);
  const checkDigit = Number(normalized.slice(-1));
  return computeCheckDigit(body) === checkDigit;
}

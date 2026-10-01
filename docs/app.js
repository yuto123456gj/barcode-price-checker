/* =====================================================================
 * 単価ウォッチ — 画面・カメラ・保存
 * 判定ロジックは logic.js (Logic) 側。ここは入出力だけを扱う。
 * ===================================================================== */

(function () {
  'use strict';

  var L = Logic;
  var PER_100 = { g: true, ml: true };
  var LS_PRODUCTS = 'tanka-watch-products';
  var LS_STORE = 'tanka-watch-store';

  /* ---------------------------------------------------------------- */
  /* 表示ヘルパ                                                        */
  /* ---------------------------------------------------------------- */

  function yen(value) {
    if (value === null || value === undefined) return '—';
    var r = Math.round(value * 100) / 100;
    var s = Number.isInteger(r) ? String(r) : r.toFixed(2);
    return '¥' + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 単価を日本の値札の流儀（100gあたり）に直す。 */
  function unitDisplay(value, useUnit, unit) {
    if (value === null || value === undefined) return { amount: '—', suffix: '' };
    if (!useUnit) return { amount: yen(value), suffix: '総額' };
    if (PER_100[unit]) return { amount: yen(value * 100), suffix: '/ 100' + unit };
    return { amount: yen(value), suffix: '/ 1' + unit };
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* ---------------------------------------------------------------- */
  /* 保存 (localStorage)                                               */
  /* ---------------------------------------------------------------- */

  var products = {};

  function loadProducts() {
    try {
      var raw = localStorage.getItem(LS_PRODUCTS);
      products = raw ? JSON.parse(raw) : {};
    } catch (e) {
      products = {};
      setStoreState('warn', '保存できません');
    }
  }

  function persistProducts() {
    try {
      localStorage.setItem(LS_PRODUCTS, JSON.stringify(products));
      return true;
    } catch (e) {
      setStoreState('warn', '保存できません');
      return false;
    }
  }

  function setStoreState(kind, text) {
    el.dot.className = 'dot ' + kind;
    el.storeState.textContent = text;
  }

  /* ---------------------------------------------------------------- */
  /* 要素                                                              */
  /* ---------------------------------------------------------------- */

  var el = {};
  ['dot', 'storeState', 'viewport', 'video', 'viewportIdle', 'frame', 'laser', 'diag',
   'scanBtn', 'torchBtn', 'photoBtn', 'photoInput',
   'code', 'codeHint', 'breakdown', 'digits', 'breakdownNote',
   'known', 'knownName', 'knownCount', 'nameField', 'name',
   'price', 'pricePrefill', 'qty', 'unit', 'store', 'checkBtn',
   'verdictWrap', 'verdict', 'verdictLabel', 'verdictPrice', 'verdictMeta', 'verdictNote', 'saveBtn',
   'tabHistory', 'tabProducts', 'paneHistory', 'paneProducts',
   'historyRows', 'historyEmpty', 'productRows', 'productsEmpty'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  var state = { key: null, parsed: null, evaluation: null };

  var SAMPLES = [
    { name: 'サントリー 天然水 550ml', best: 0.16, unit: 'ml', n: 4 },
    { name: '国産豚バラ肉', best: 2.58, unit: 'g', n: 3 }
  ];

  function currentProduct() {
    return state.key ? products[state.key] || null : null;
  }

  /* ---------------------------------------------------------------- */
  /* カメラ                                                            */
  /* ---------------------------------------------------------------- */

  var cam = {
    scanning: false,
    stream: null,
    reader: null,
    timer: null,
    detector: null,
    engine: '—',
    attempts: 0,
    lastError: '',
    lastCode: null,
    lastAt: 0
  };

  function supportsDetector() {
    return typeof window.BarcodeDetector === 'function';
  }

  /**
   * @param tryHarder 静止画では精度優先。ライブ映像では1フレームあたりを速くするため false。
   */
  function makeZxingReader(tryHarder) {
    var Z = window.ZXing;
    var hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
      Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
      Z.BarcodeFormat.CODE_128
    ]);
    if (tryHarder) hints.set(Z.DecodeHintType.TRY_HARDER, true);
    return new Z.BrowserMultiFormatReader(hints);
  }

  /** 画面に出す診断。読めないときに原因を切り分けるため。 */
  function setDiag(text) {
    el.diag.textContent = text;
    el.diag.hidden = !text;
  }

  function diagLine() {
    return cam.engine
      + ' · ' + (el.video.videoWidth || 0) + '×' + (el.video.videoHeight || 0)
      + ' · 試行' + cam.attempts + '回'
      + (cam.lastError ? ' · ' + cam.lastError : '');
  }

  async function startScan() {
    if (cam.scanning) { stopScan(); return; }

    if (!window.isSecureContext) {
      hintError('カメラは HTTPS でしか使えません。GitHub Pages など https:// のURLで開いてください。');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hintError('このブラウザはカメラに対応していません。写真ボタンか手入力をお使いください。');
      return;
    }

    el.scanBtn.disabled = true;
    el.scanBtn.textContent = '起動中…';

    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (error) {
      el.scanBtn.disabled = false;
      el.scanBtn.textContent = 'カメラでスキャン';
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        hintError('カメラが許可されませんでした。ブラウザの設定でこのサイトのカメラを許可してください。');
      } else if (error && error.name === 'NotFoundError') {
        hintError('カメラが見つかりません。写真ボタンか手入力をお使いください。');
      } else {
        hintError('カメラを起動できませんでした。写真ボタンか手入力をお使いください。');
      }
      return;
    }

    cam.scanning = true;
    // Safari は属性だけだと自動再生を拒むことがあるのでプロパティでも立てる。
    el.video.muted = true;
    el.video.playsInline = true;
    el.video.setAttribute('playsinline', '');
    el.video.srcObject = cam.stream;
    el.video.hidden = false;
    el.viewportIdle.hidden = true;
    el.frame.hidden = false;
    el.laser.hidden = false;
    el.scanBtn.disabled = false;
    el.scanBtn.textContent = 'スキャンを止める';
    el.scanBtn.setAttribute('aria-pressed', 'true');
    hintNormal('バーコードを枠に入れてください。近づけすぎると読めません。');

    try { await el.video.play(); } catch (e) { /* 自動再生が拒否されても続行 */ }

    setupTorch();

    if (supportsDetector()) {
      cam.engine = 'BarcodeDetector';
      cam.detector = new window.BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
      });
    } else if (window.ZXing) {
      cam.engine = 'ZXing';
      cam.reader = makeZxingReader(false);
    } else {
      hintError('読み取りライブラリを読み込めませんでした。手入力をお使いください。');
      stopScan();
      return;
    }

    cam.attempts = 0;
    cam.lastError = '';
    setDiag(diagLine());
    scanLoop();
  }

  /**
   * 1フレームずつ読む自前のループ。
   * ZXing の decodeFromVideoElement は「1回だけ」読む版なので連続スキャンには使えない。
   * decode() を直接呼んで、見つからなければ次のフレームへ進める。
   */
  async function scanLoop() {
    if (!cam.scanning) return;

    // 映像が来る前は videoWidth が 0。準備できるまで待つ。
    if (!el.video.videoWidth) {
      cam.timer = setTimeout(scanLoop, 150);
      return;
    }

    cam.attempts++;

    try {
      if (cam.detector) {
        var found = await cam.detector.detect(el.video);
        if (found && found.length) { onDetected(found[0].rawValue); return; }
      } else {
        var result = cam.reader.decode(el.video);   // 見つからなければ throw
        if (result) { onDetected(result.getText()); return; }
      }
      cam.lastError = '';
    } catch (error) {
      // バーコードが写っていないフレームは NotFoundException。これは正常。
      var name = (error && (error.name || error.constructor && error.constructor.name)) || '';
      cam.lastError = /NotFound|Checksum|Format/.test(name) ? '' : name;
    }

    if (cam.attempts % 5 === 0) setDiag(diagLine());
    cam.timer = setTimeout(scanLoop, cam.detector ? 120 : 180);
  }

  function setupTorch() {
    var track = cam.stream && cam.stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    var caps = {};
    try { caps = track.getCapabilities(); } catch (e) { return; }
    if (!caps.torch) return;

    el.torchBtn.hidden = false;
    el.torchBtn.setAttribute('aria-pressed', 'false');
    el.torchBtn.onclick = async function () {
      var on = el.torchBtn.getAttribute('aria-pressed') === 'true';
      try {
        await track.applyConstraints({ advanced: [{ torch: !on }] });
        el.torchBtn.setAttribute('aria-pressed', String(!on));
      } catch (e) { /* 対応していない端末 */ }
    };
  }

  function stopScan() {
    cam.scanning = false;

    if (cam.timer) { clearTimeout(cam.timer); cam.timer = null; }
    if (cam.reader) {
      try { cam.reader.reset(); } catch (e) { /* 既に停止 */ }
      cam.reader = null;
    }
    if (cam.stream) {
      cam.stream.getTracks().forEach(function (t) { t.stop(); });
      cam.stream = null;
    }

    el.video.srcObject = null;
    el.video.hidden = true;
    el.viewportIdle.hidden = false;
    el.frame.hidden = true;
    el.laser.hidden = true;
    el.torchBtn.hidden = true;
    el.scanBtn.disabled = false;
    el.scanBtn.textContent = 'カメラでスキャン';
    el.scanBtn.setAttribute('aria-pressed', 'false');
    setDiag('');
  }

  /** 読み取り成功。同じコードの連続ヒットは2秒間無視する。 */
  function onDetected(rawCode) {
    var code = L.normalizeCode(rawCode);
    var now = Date.now();
    if (code === cam.lastCode && now - cam.lastAt < 2000) return;
    cam.lastCode = code;
    cam.lastAt = now;

    feedback();
    stopScan();

    el.code.value = code;
    el.price.dataset.prefilled = '';
    el.pricePrefill.hidden = true;
    onCodeChange();

    var product = currentProduct();
    (product ? el.price : el.name).focus({ preventScroll: true });
  }

  /** 読み取れたことを振動と短い音で知らせる。どちらも失敗して構わない。 */
  function feedback() {
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.13);
      osc.onended = function () { try { ctx.close(); } catch (e) {} };
    } catch (e) { /* 音が出せなくても続行 */ }
  }

  /* ---- 写真からの読み取り（カメラが使えないときの逃げ道） ---- */

  async function decodePhoto(file) {
    var bitmap = await createImageBitmap(file);
    var max = 1600;
    var scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    if (supportsDetector()) {
      try {
        var detector = new window.BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
        });
        var found = await detector.detect(canvas);
        if (found && found.length) return found[0].rawValue;
      } catch (e) { /* ZXing にフォールバック */ }
    }

    if (window.ZXing) {
      var img = new Image();
      img.src = canvas.toDataURL('image/png');
      await img.decode();
      var result = await makeZxingReader(true).decodeFromImage(img);
      return result.getText();
    }
    return null;
  }

  async function onPhoto(event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    hintNormal('読み取り中…');
    try {
      var code = await decodePhoto(file);
      if (code) {
        onDetected(code);
      } else {
        hintError('バーコードを読み取れませんでした。数字を手で入力してください。');
      }
    } catch (e) {
      hintError('バーコードを読み取れませんでした。バーコードが画面いっぱいに写るように撮り直すか、数字を手で入力してください。');
    }
  }

  /* ---------------------------------------------------------------- */
  /* コード入力                                                        */
  /* ---------------------------------------------------------------- */

  function hintNormal(text) {
    el.codeHint.className = 'hint';
    el.codeHint.textContent = text;
  }

  function hintError(text) {
    el.codeHint.className = 'hint error';
    el.codeHint.textContent = text;
  }

  function onCodeChange() {
    var raw = L.normalizeCode(el.code.value);
    state.evaluation = null;
    el.verdictWrap.hidden = true;

    if (!raw) {
      state.key = null;
      state.parsed = null;
      el.breakdown.hidden = true;
      hintNormal('かざすだけで読み取ります。手で入力しても構いません。');
      renderProductArea();
      return;
    }

    state.parsed = L.parseInstoreCode(raw);
    state.key = L.toLookupKey(raw);

    if (!L.isValidBarcode(raw)) {
      hintError(raw.length + '桁です。JANコードは8桁か13桁。数字だけ入れてください。');
      el.breakdown.hidden = true;
      renderProductArea();
      return;
    }

    hintNormal(L.isInstoreCode(raw)
      ? 'インストアコード（店内で採番された商品）。商品名は手入力です。'
      : 'JANコード。商品名は初回だけ手入力してください。');

    renderBreakdown();
    renderProductArea();
  }

  function renderBreakdown() {
    var p = state.parsed;
    if (!p) { el.breakdown.hidden = true; return; }

    el.breakdown.hidden = false;
    el.digits.innerHTML = '';

    [['', p.prefix, '種別'],
     ['is-item', p.itemCode, '商品コード'],
     ['is-value', String(p.price).padStart(5, '0'), '価格'],
     ['', p.checkDigit, 'CD']].forEach(function (parts) {
      var seg = document.createElement('div');
      seg.className = 'seg ' + parts[0];
      var b = document.createElement('b');
      b.textContent = parts[1];
      var s = document.createElement('small');
      s.textContent = parts[2];
      seg.appendChild(b);
      seg.appendChild(s);
      el.digits.appendChild(seg);
    });

    el.breakdownNote.textContent = '埋め込み価格 ' + yen(p.price) + '。名寄せキー ' + p.canonicalCode
      + ' として記録するので、値引きでコードが変わっても同じ商品に積み上がります。';

    if (el.price.value === '' || el.price.dataset.prefilled === '1') {
      el.price.value = String(p.price);
      el.price.dataset.prefilled = '1';
      el.pricePrefill.hidden = false;
    }
  }

  function renderProductArea() {
    var product = currentProduct();

    if (product) {
      el.known.hidden = false;
      el.knownName.textContent = product.name;
      el.knownCount.textContent = (product.history || []).length + '件の記録';
      el.nameField.hidden = true;
      el.name.value = product.name;
      if (product.unit) el.unit.value = product.unit;
    } else {
      el.known.hidden = true;
      el.nameField.hidden = !state.key;
      if (!state.key) el.name.value = '';
    }

    renderHistory();
  }

  /* ---------------------------------------------------------------- */
  /* 判定と保存                                                        */
  /* ---------------------------------------------------------------- */

  function check() {
    var raw = L.normalizeCode(el.code.value);
    if (!raw) { hintError('バーコードを読み取るか、数字を入力してください。'); return; }

    var price = Number(el.price.value);
    if (el.price.value === '' || !isFinite(price) || price < 0) {
      hintError('価格を入力してください。');
      return;
    }

    var product = currentProduct();
    var name = (product && product.name) || el.name.value.trim();
    if (!name) { hintError('商品名を入力してください。'); return; }

    var qtyRaw = el.qty.value;
    var qty = qtyRaw === '' ? null : Number(qtyRaw);
    if (qty !== null && (!isFinite(qty) || qty <= 0)) {
      hintError('容量は0より大きい数で入れてください。');
      return;
    }

    state.evaluation = L.evaluatePrice(product ? product.history || [] : [], price, qty);
    renderVerdict(state.evaluation);
  }

  function renderVerdict(ev) {
    var unit = el.unit.value;
    el.verdictWrap.hidden = false;
    el.verdict.className = 'verdict s-' + ev.status;
    el.verdictLabel.textContent = L.LABELS[ev.status];

    var cur = unitDisplay(ev.current, ev.useUnit, unit);
    el.verdictPrice.innerHTML = '';
    var amount = document.createElement('span');
    amount.textContent = cur.amount;
    var suffix = document.createElement('em');
    suffix.textContent = cur.suffix;
    el.verdictPrice.appendChild(amount);
    el.verdictPrice.appendChild(suffix);

    el.verdictMeta.innerHTML = '';
    if (ev.size > 0) {
      var low = unitDisplay(ev.lowest, ev.useUnit, unit);
      var avg = unitDisplay(ev.average, ev.useUnit, unit);
      [['これまでの最安', low.amount],
       ['平均', avg.amount],
       ['平均との差', (ev.diff > 0 ? '+' : '') + ev.diff + '%']].forEach(function (pair) {
        var box = document.createElement('div');
        var dt = document.createElement('dt');
        dt.textContent = pair[0];
        var dd = document.createElement('dd');
        dd.textContent = pair[1];
        box.appendChild(dt);
        box.appendChild(dd);
        el.verdictMeta.appendChild(box);
      });
      el.verdictMeta.hidden = false;
    } else {
      el.verdictMeta.hidden = true;
    }

    var product = currentProduct();
    var note;
    if (ev.size === 0) {
      note = (ev.useUnit && product && (product.history || []).length)
        ? '過去の記録に容量が入っていないので、単価では比べられませんでした。今回を基準にします。'
        : 'これが最初の記録です。次に同じ商品をスキャンすると、この値段と比べます。';
    } else {
      var src = ev.lowestRecord;
      note = '過去' + ev.size + '件と比較' + (src && src.store ? '（最安は' + src.store + '）' : '')
        + '。' + (ev.useUnit ? '容量で割った単価で比べています。' : '容量を入れると単価で比べます。');
    }
    el.verdictNote.textContent = note;

    el.saveBtn.disabled = false;
    el.saveBtn.textContent = 'この価格を履歴に保存';
    el.verdictWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function save() {
    if (!state.evaluation || !state.key) return;

    var existing = currentProduct();
    var qtyRaw = el.qty.value;
    var qty = qtyRaw === '' ? null : Number(qtyRaw);

    var entry = {
      price: Number(el.price.value),
      qty: qty,
      unit: qty === null ? null : el.unit.value,
      store: el.store.value.trim() || null,
      at: new Date().toISOString()
    };

    products[state.key] = {
      janCode: state.key,
      name: (existing && existing.name) || el.name.value.trim(),
      unit: el.unit.value,
      isInstore: L.isInstoreCode(state.key),
      createdAt: (existing && existing.createdAt) || entry.at,
      history: (existing ? existing.history || [] : []).concat([entry])
    };

    if (persistProducts()) {
      el.saveBtn.disabled = true;
      el.saveBtn.textContent = '保存しました';
      try { localStorage.setItem(LS_STORE, entry.store || ''); } catch (e) {}
    } else {
      el.saveBtn.textContent = '保存できませんでした';
    }

    renderProducts();
    renderProductArea();
  }

  /* ---------------------------------------------------------------- */
  /* 一覧                                                              */
  /* ---------------------------------------------------------------- */

  function renderHistory() {
    var product = currentProduct();
    var history = product ? (product.history || []) : [];

    if (!product || history.length === 0) {
      el.historyRows.hidden = true;
      el.historyEmpty.hidden = false;
      el.historyEmpty.textContent = state.key
        ? 'この商品の記録はまだありません。'
        : 'コードを読み取ると、その商品の価格履歴が出ます。';
      return;
    }

    var unit = product.unit || 'g';
    var metrics = history.map(function (h) { return h.qty ? h.price / h.qty : h.price; });
    var best = Math.min.apply(null, metrics);

    el.historyEmpty.hidden = true;
    el.historyRows.hidden = false;
    el.historyRows.innerHTML = '';

    history.slice().reverse().forEach(function (h) {
      var metric = h.qty ? h.price / h.qty : h.price;
      var disp = unitDisplay(L.round(metric), !!h.qty, h.unit || unit);

      var li = document.createElement('li');
      var main = document.createElement('div');
      main.className = 'row-main';

      var title = document.createElement('div');
      title.className = 'row-title';
      title.textContent = h.store || '店舗未入力';

      var sub = document.createElement('div');
      sub.className = 'row-sub';
      sub.textContent = formatDate(h.at) + ' · ' + yen(h.price)
        + (h.qty ? ' / ' + h.qty + (h.unit || unit) : '');

      main.appendChild(title);
      main.appendChild(sub);

      var value = document.createElement('div');
      value.className = 'row-value' + (Math.abs(metric - best) < 1e-9 ? ' best' : '');
      value.textContent = disp.amount;

      li.appendChild(main);
      li.appendChild(value);
      el.historyRows.appendChild(li);
    });
  }

  function renderProducts() {
    var keys = Object.keys(products);
    el.productRows.innerHTML = '';

    if (keys.length === 0) {
      el.productRows.hidden = false;
      el.productsEmpty.hidden = false;
      el.productsEmpty.textContent = 'まだ登録がありません。下は表示例です。';
      SAMPLES.forEach(function (s) {
        var li = document.createElement('li');
        li.className = 'sample';

        var main = document.createElement('div');
        main.className = 'row-main';
        var title = document.createElement('div');
        title.className = 'row-title';
        title.textContent = s.name;
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '例';
        title.appendChild(tag);
        var sub = document.createElement('div');
        sub.className = 'row-sub';
        sub.textContent = s.n + '件の記録';
        main.appendChild(title);
        main.appendChild(sub);

        var value = document.createElement('div');
        value.className = 'row-value';
        value.textContent = unitDisplay(s.best, true, s.unit).amount;

        li.appendChild(main);
        li.appendChild(value);
        el.productRows.appendChild(li);
      });
      return;
    }

    el.productsEmpty.hidden = true;
    el.productRows.hidden = false;

    keys.map(function (k) { return { key: k, p: products[k] }; })
      .sort(function (a, b) { return String(b.p.createdAt).localeCompare(String(a.p.createdAt)); })
      .forEach(function (item) {
        var p = item.p;
        var history = p.history || [];
        var metrics = history.map(function (h) { return h.qty ? h.price / h.qty : h.price; });
        var best = metrics.length ? Math.min.apply(null, metrics) : null;
        var anyQty = history.some(function (h) { return !!h.qty; });

        var li = document.createElement('li');
        var main = document.createElement('div');
        main.className = 'row-main';

        var title = document.createElement('div');
        title.className = 'row-title';
        title.textContent = p.name;
        if (p.isInstore) {
          var tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = '店内';
          title.appendChild(tag);
        }

        var sub = document.createElement('div');
        sub.className = 'row-sub';
        sub.textContent = history.length + '件 · ' + item.key;

        main.appendChild(title);
        main.appendChild(sub);

        var value = document.createElement('div');
        value.className = 'row-value best';
        value.textContent = best === null ? '—' : unitDisplay(L.round(best), anyQty, p.unit || 'g').amount;

        li.appendChild(main);
        li.appendChild(value);
        li.addEventListener('click', function () {
          el.code.value = item.key;
          el.price.value = '';
          el.price.dataset.prefilled = '';
          el.pricePrefill.hidden = true;
          onCodeChange();
          selectTab('history');
          el.code.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        el.productRows.appendChild(li);
      });
  }

  function selectTab(which) {
    var history = which === 'history';
    el.tabHistory.setAttribute('aria-selected', String(history));
    el.tabProducts.setAttribute('aria-selected', String(!history));
    el.paneHistory.hidden = !history;
    el.paneProducts.hidden = history;
  }

  /* ---------------------------------------------------------------- */
  /* 起動                                                              */
  /* ---------------------------------------------------------------- */

  el.scanBtn.addEventListener('click', startScan);
  el.photoBtn.addEventListener('click', function () { el.photoInput.click(); });
  el.photoInput.addEventListener('change', onPhoto);
  el.code.addEventListener('input', onCodeChange);
  el.checkBtn.addEventListener('click', check);
  el.saveBtn.addEventListener('click', save);
  el.tabHistory.addEventListener('click', function () { selectTab('history'); });
  el.tabProducts.addEventListener('click', function () { selectTab('products'); });
  el.price.addEventListener('input', function () {
    el.price.dataset.prefilled = '';
    el.pricePrefill.hidden = true;
  });

  // 画面を離れたらカメラを止める（バッテリーとプライバシーのため）。
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && cam.scanning) stopScan();
  });
  window.addEventListener('pagehide', stopScan);

  loadProducts();
  setStoreState('local', 'この端末に保存');
  try {
    var lastStore = localStorage.getItem(LS_STORE);
    if (lastStore) el.store.value = lastStore;
  } catch (e) { /* 使えなくても続行 */ }

  renderProducts();
  renderProductArea();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* オフライン対応なしで続行 */ });
    });
  }
})();

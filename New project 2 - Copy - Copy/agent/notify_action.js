function normalizeNotify(obj) {
  const afterMs = Number(obj?.after_ms ?? obj?.afterMs ?? 0);
  const text = String(obj?.text ?? '');
  const why = String(obj?.why ?? '');
  return { afterMs, text, why };
}

module.exports = {
  normalizeNotify
};

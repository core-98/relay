import qrcode from "qrcode-generator";

/**
 * Builds a single SVG path covering every dark module, so an invite QR is
 * one crisp vector element rather than a few hundred rects.
 */
export function qrPath(text: string, margin = 2) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + margin * 2;
  let path = "";

  for (let row = 0; row < count; row += 1) {
    let run = 0;
    for (let column = 0; column <= count; column += 1) {
      const dark = column < count && qr.isDark(row, column);
      if (dark) {
        run += 1;
        continue;
      }
      if (run > 0) {
        path += `M${column - run + margin} ${row + margin}h${run}v1h-${run}z`;
        run = 0;
      }
    }
  }

  return { size, path };
}

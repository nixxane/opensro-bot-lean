/*
qr.mjs - a QR code as an SVG string, made inside the Worker

The encoder is the pinned npm package qrcode-generator (MIT, no dependencies); wrangler bundles it into the Worker, so
nothing is fetched from a CDN when a page is shown. This file only turns its module matrix into one <path>. The code is
always black on white, with the 4-module quiet zone the standard asks for, even when the page around it is dark: a
phone camera cannot read a light-on-dark code reliably.
*/
import qrcode from 'qrcode-generator';

const QUIET_ZONE = 4; // modules of white around the code (ISO/IEC 18004)
const ERROR_CORRECTION = 'M'; // about 15% of the code can be damaged; a dashboard link fits in version 4 or 5

/*
================
qrMatrix

The dark modules of the code for text, as an array of rows of booleans. Throws if text does not fit (it always fits for
a hub link, which is about 80 bytes).
================
*/
export function qrMatrix(text) {
  const qr = qrcode(0, ERROR_CORRECTION); // 0 = the smallest version that holds the data
  qr.addData(String(text), 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

/*
================
qrSvg

An <svg> element for text. One path draws every dark module as a unit square; the viewBox includes the quiet zone, and the
element scales to the width of its container.
================
*/
export function qrSvg(text, label = 'QR code') {
  const matrix = qrMatrix(text), size = matrix.length + 2 * QUIET_ZONE;
  let path = '';
  matrix.forEach((cells, row) => cells.forEach((dark, col) => {
    if (dark) path += 'M' + (col + QUIET_ZONE) + ' ' + (row + QUIET_ZONE) + 'h1v1h-1z';
  }));
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' + label.replace(/[^\w .-]/g, '') + '" shape-rendering="crispEdges">'
    + '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path fill="#000" d="' + path + '"/></svg>';
}

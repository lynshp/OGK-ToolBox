import type { ReactElement } from "react";

const pencilGamepadPath = "M480-654Zm174 174Zm-348 0Zm174 174Zm-28-262-80-80q-6-6-9-13.5t-3-15.5v-163q0-17 11.5-28.5T400-880h160q17 0 28.5 11.5T600-840v163q0 8-3 15.5t-9 13.5l-80 80q-6 6-13 8.5t-15 2.5q-8 0-15-2.5t-13-8.5Zm116 116q-6-6-8.5-13t-2.5-15q0-8 2.5-15t8.5-13l80-80q6-6 13.5-9t15.5-3h163q17 0 28.5 11.5T880-560v160q0 17-11.5 28.5T840-360H677q-8 0-15.5-3t-13.5-9l-80-80ZM80-400v-160q0-17 11.5-28.5T120-600h163q8 0 15.5 3t13.5 9l80 80q6 6 8.5 13t2.5 15q0 8-2.5 15t-8.5 13l-80 80q-6 6-13.5 9t-15.5 3H120q-17 0-28.5-11.5T80-400Zm280 280v-163q0-8 3-15.5t9-13.5l80-80q6-6 13-8.5t15-2.5q8 0 15 2.5t13 8.5l80 80q6 6 9 13.5t3 15.5v163q0 17-11.5 28.5T560-80H400q-17 0-28.5-11.5T360-120Zm120-534 40-40v-106h-80v106l40 40ZM160-440h106l40-40-40-40H160v80Zm280 280h80v-106l-40-40-40 40v106Zm254-280h106v-80H694l-40 40 40 40Z";
const pencilCheckPath = "m382-354 339-339q12-12 28-12t28 12q12 12 12 28.5T777-636L410-268q-12 12-28 12t-28-12L182-440q-11-11-11.5-28.5T183-497q12-12 28.5-12t28.5 12l142 143Z";
const pencilClosePath = "M480-424 284-228q-11 11-28 11t-28-11q-11-11-11-28t11-28l196-196-196-196q-11-11-11-28t11-28q11-11 28-11t28 11l196 196 196-196q11-11 28-11t28 11q11 11 11 28t-11 28L536-480l196 196q11 11 11 28t-11 28q-11 11-28 11t-28-11L480-424Z";

const PencilSymbol = ({ path }: { path: string }): ReactElement =>
  <svg className="material-icon pencil-symbol-icon" viewBox="0 -960 960 960" aria-hidden="true"><path d={path} /></svg>;

/** The selected Material Symbols Rounded gamepad glyph from the Pencil home status-card design. */
export function PencilGamepadIcon(): ReactElement {
  return <PencilSymbol path={pencilGamepadPath} />;
}

/** The status-result glyphs from the Pencil home status-card design. */
export function PencilCheckIcon(): ReactElement {
  return <PencilSymbol path={pencilCheckPath} />;
}

export function PencilCloseIcon(): ReactElement {
  return <PencilSymbol path={pencilClosePath} />;
}

export function PencilChevronDownIcon(): ReactElement {
  return <svg className="material-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
}

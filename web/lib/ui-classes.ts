/**
 * Class-string recipes from STYLES.md §7. Reach for these before writing new class strings.
 * Every gray class has its dark: partner. Hue is reserved for status.
 */

/** Card / section surface: the most-used container. */
export const sectionClass = "rounded-xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800";
/** Card that can be hovered: border colour changes, no lift. */
export const interactiveSectionClass = `${sectionClass} transition-colors hover:border-gray-200 dark:hover:border-gray-600`;
export const pageContainerClass = "container mx-auto max-w-page px-4 py-8 sm:py-10";
export const appPageClass = "mx-auto w-full max-w-7xl space-y-6";

/** Buttons */
const buttonBase =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0";
export const primaryButtonClass = `${buttonBase} bg-gray-900 text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200`;
export const secondaryButtonClass = `${buttonBase} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600`;
export const ghostButtonClass = `${buttonBase} text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white`;
export const destructiveButtonClass = `${buttonBase} bg-red-600 text-white hover:bg-red-700`;
export const linkButtonClass = `${buttonBase} font-medium text-gray-900 underline-offset-4 hover:underline dark:text-white`;
export const iconButtonClass =
  "relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white";

/** Links */
export const navLinkClass = "text-sm font-medium text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-300 dark:hover:text-white";
export const inlineLinkClass = "font-medium text-gray-900 underline-offset-4 hover:underline dark:text-white";
export const subtleLinkClass = "text-xs font-medium text-gray-500 hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-white";

/** Form controls */
export const focusRingClass =
  "focus:outline-none focus:ring-2 focus:ring-gray-900/10 focus:border-gray-400 dark:focus:ring-gray-100/10 dark:focus:border-gray-500";
export const inputClass = `block w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:placeholder:text-gray-500 ${focusRingClass} aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-red-500/15 dark:aria-[invalid=true]:border-red-400`;
export const selectClass = inputClass;
export const textareaClass = `${inputClass} shadow-sm`;
export const labelClass = "text-sm font-medium text-gray-900 dark:text-white";

/** Filter / tab pills (segmented controls) */
export const pillBaseClass = "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors";
export const activePillClass = "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900";
export const inactivePillClass =
  "border-gray-200 bg-white text-gray-600 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-600";

/** Selectable option card (radio card): selected uses the inverted treatment's border. */
export const optionCardClass =
  "cursor-pointer rounded-xl border bg-white p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-900/20 dark:bg-gray-800 dark:has-[:focus-visible]:ring-gray-100/20";
export const optionCardActiveClass = "border-gray-900 ring-1 ring-gray-900 dark:border-gray-100 dark:ring-gray-100";
export const optionCardInactiveClass = "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600";

/** Callouts, insets & badges */
export const calloutClass = "rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50";
export const insetClass = "rounded-lg bg-gray-50 dark:bg-gray-900/50";
export const iconTileClass = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200";
export const neutralBadgeClass = "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300";
export const successBadgeClass = "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
export const warningBadgeClass = "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
export const errorBadgeClass = "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
export const infoBadgeClass = "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";

/** Typography */
export const pageTitleClass = "break-words text-xl font-bold tracking-tight text-gray-900 sm:text-2xl md:text-3xl dark:text-white";
export const sectionTitleClass = "text-lg font-semibold text-gray-900 dark:text-white";
export const itemTitleClass = "text-sm font-semibold leading-snug text-gray-900 dark:text-white";
export const bodyTextClass = "text-sm text-gray-600 dark:text-gray-300";
export const descriptionClass = "text-sm text-gray-500 dark:text-gray-400";
export const metaClass = "text-xs text-gray-500 dark:text-gray-400";
export const eyebrowClass = "text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";

/** Tables */
export const tableHeadCellClass =
  "bg-gray-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900/40 dark:text-gray-400";
export const tableRowClass = "border-t border-gray-100 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40";
export const tableCellClass = "px-4 py-3 align-middle";

/** Loading */
export const skeletonClass = "animate-pulse rounded bg-gray-200/80 dark:bg-gray-700/80";

/** Overlay surfaces */
export const popoverClass = "rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800";
export const modalPanelClass = "w-full max-w-md overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-gray-900";

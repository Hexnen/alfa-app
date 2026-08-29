/**
 * Prymitywy wykresów analityki finansowej.
 *
 * Wszystko tutaj jest prezentacyjne: propsy wchodzą, SVG/divy wychodzą.
 * Żadnego pobierania danych, żadnego API, żadnego routera poza `EmptyState`.
 * W repo nie ma biblioteki wykresów (ani recharts, ani d3) i celowo jej nie
 * dodajemy — wszystko jest ręcznym SVG w idiomie `CmaTrends.tsx`.
 */

export * from "./palette";
export * from "./format";
export * from "./scale";

export { KpiTile, type KpiTileProps, type KpiTone } from "./KpiTile";
export { KpiRow, type KpiRowProps } from "./KpiRow";
export { RankBar, type RankBarProps } from "./RankBar";
export {
  RankBarDiverging,
  type RankBarDivergingProps,
} from "./RankBarDiverging";
export {
  ShareBar,
  type ShareBarProps,
  type ShareSegment,
} from "./ShareBar";
export {
  StackedBarChart,
  type StackedBarChartProps,
  type StackedRow,
  type StackedSegment,
} from "./StackedBarChart";
export { MarginGauge, type MarginGaugeProps, type MarginGaugeSize } from "./MarginGauge";
export {
  ScatterQuadrant,
  type ScatterQuadrantProps,
  type ScatterRow,
} from "./ScatterQuadrant";
export {
  WaterfallChart,
  type WaterfallChartProps,
  type WaterfallStep,
} from "./WaterfallChart";
export {
  ChartCard,
  type ChartCardProps,
  type ChartTableData,
} from "./ChartCard";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { CoverageNote, type CoverageProps } from "./CoverageNote";
export { Legend, LegendItem, LegendSwatch, type LegendItemProps } from "./Legend";

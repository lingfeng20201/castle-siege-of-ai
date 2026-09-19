'use client';

import { useEffect, useMemo, useRef } from 'react';

/**
 * components/settings/UsageChart.tsx —— ECharts 图表封装（暗色霓虹主题）
 *
 * 用法：
 *   <UsageChart title="近 30 天 token 趋势" trend={series} />
 *   <UsageChart title="各模型占比" pie={byModel.map(m => ({ name: m.model, value: m.tokens }))} />
 *
 * 说明：echarts 体积较大，这里用动态 import 避免拖累首屏与 SSR；
 * 组件卸载时 dispose，容器尺寸变化用 ResizeObserver 自适应。
 */

export interface TrendPoint {
  date: string;
  calls: number;
  tokens: number;
  cost: number;
}

export interface PieItem {
  name: string;
  value: number;
}

interface Props {
  title?: string;
  height?: number;
  /** 折线 + 柱：token 趋势与调用次数 */
  trend?: TrendPoint[];
  /** 环形饼：占比 */
  pie?: PieItem[];
}

const PALETTE = ['#00f0ff', '#ff3b5c', '#ffd700', '#8b5cf6', '#39ff14', '#ffb020', '#8aa0b8', '#5eead4'];

export default function UsageChart({ title, height = 260, trend, pie }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const trendKey = useMemo(() => JSON.stringify(trend ?? []), [trend]);
  const pieKey = useMemo(() => JSON.stringify(pie ?? []), [pie]);

  useEffect(() => {
    let disposed = false;
    let chart: { setOption: (o: unknown) => void; resize: () => void; dispose: () => void } | null = null;
    let ro: ResizeObserver | null = null;

    void (async () => {
      if (!ref.current) return;
      const echarts = await import('echarts');
      if (disposed || !ref.current) return;

      chart = echarts.init(ref.current);

      const trendData = JSON.parse(trendKey) as TrendPoint[];
      const pieData = JSON.parse(pieKey) as PieItem[];

      chart.setOption(
        pieData.length > 0 && trendData.length === 0
          ? buildPieOption(pieData)
          : buildTrendOption(trendData),
      );

      if (typeof ResizeObserver !== 'undefined' && ref.current) {
        ro = new ResizeObserver(() => chart?.resize());
        ro.observe(ref.current);
      }
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      chart?.dispose();
      chart = null;
    };
  }, [trendKey, pieKey]);

  return (
    <div className="panel p-4">
      {title && <h3 className="mb-2 font-display text-sm text-neon-blue">{title}</h3>}
      <div ref={ref} style={{ height }} className="w-full" />
    </div>
  );
}

/* ── 趋势图：tokens 面积折线（左轴）+ 调用次数柱（右轴） ── */
function buildTrendOption(rows: TrendPoint[]) {
  const dates = rows.map((r) => r.date.slice(5)); // MM-DD
  return {
    backgroundColor: 'transparent',
    grid: { left: 8, right: 8, top: 32, bottom: 8, containLabel: true },
    legend: {
      data: ['tokens', '调用次数'],
      textStyle: { color: '#8aa0b8', fontSize: 11 },
      top: 0,
      right: 0,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(10,14,23,0.95)',
      borderColor: 'rgba(0,240,255,0.3)',
      textStyle: { color: '#e6f1ff', fontSize: 11 },
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
      axisLabel: { color: '#8aa0b8', fontSize: 10 },
    },
    yAxis: [
      {
        type: 'value',
        name: 'tokens',
        nameTextStyle: { color: '#8aa0b8', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
        axisLabel: { color: '#8aa0b8', fontSize: 10 },
      },
      {
        type: 'value',
        name: '次数',
        nameTextStyle: { color: '#8aa0b8', fontSize: 10 },
        splitLine: { show: false },
        axisLabel: { color: '#8aa0b8', fontSize: 10 },
      },
    ],
    series: [
      {
        name: '调用次数',
        type: 'bar',
        yAxisIndex: 1,
        data: rows.map((r) => r.calls),
        barMaxWidth: 14,
        itemStyle: { color: 'rgba(139,92,246,0.45)', borderRadius: [3, 3, 0, 0] },
      },
      {
        name: 'tokens',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        data: rows.map((r) => r.tokens),
        lineStyle: { color: '#00f0ff', width: 2 },
        itemStyle: { color: '#00f0ff' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(0,240,255,0.35)' },
              { offset: 1, color: 'rgba(0,240,255,0)' },
            ],
          },
        },
      },
    ],
  };
}

/* ── 环形饼图：各模型 token 占比 ── */
function buildPieOption(items: PieItem[]) {
  return {
    backgroundColor: 'transparent',
    color: PALETTE,
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10,14,23,0.95)',
      borderColor: 'rgba(0,240,255,0.3)',
      textStyle: { color: '#e6f1ff', fontSize: 11 },
      formatter: '{b}<br/>{c} tokens ({d}%)',
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      right: 0,
      top: 'middle',
      textStyle: { color: '#8aa0b8', fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10,
    },
    series: [
      {
        type: 'pie',
        radius: ['45%', '72%'],
        center: ['38%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#0a0e17', borderWidth: 2 },
        label: { show: false },
        labelLine: { show: false },
        data: items.map((i) => ({ name: i.name, value: i.value })),
      },
    ],
  };
}
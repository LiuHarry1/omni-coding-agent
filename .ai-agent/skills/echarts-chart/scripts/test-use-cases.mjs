#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GENERATOR = path.join(HERE, 'generate-chart.mjs')
const MAX_HTML_BYTES = 5 * 1024 * 1024
const source = 'ECharts skill regression fixtures'

const cases = [
  {
    slug: '01-line',
    input: {
      title: '月度收入趋势',
      goal: 'trend',
      chartType: 'line',
      source,
      unit: '万元',
      timeRange: { start: '2026-01-01', end: '2026-03-31' },
      incompletePeriod: { label: '3月未结', note: '截至3月15日' },
      sort: 'chronological',
      data: [
        { month: '2026-01', productA: 120, productB: 90 },
        { month: '2026-02', productA: 138, productB: 96 },
        { month: '2026-03', productA: 146, productB: 108 },
      ],
      fields: { x: 'month', y: ['productA', 'productB'] },
    },
  },
  {
    slug: '02-area',
    input: {
      title: '每日访问量',
      goal: 'trend',
      chartType: 'area',
      source,
      unit: '次',
      data: [
        { day: '周一', visits: 820 },
        { day: '周二', visits: 960 },
        { day: '周三', visits: 1100 },
      ],
      fields: { x: 'day', y: 'visits' },
    },
  },
  {
    slug: '03-bar',
    input: {
      title: '各地区销量比较',
      goal: 'compare',
      chartType: 'bar',
      source,
      unit: '台',
      data: [
        { region: '华东', sales: 320 },
        { region: '华南', sales: 260 },
        { region: '华北', sales: 210 },
      ],
      fields: { x: 'region', y: 'sales' },
    },
  },
  {
    slug: '04-stacked-bar',
    input: {
      title: '各产品季度构成',
      goal: 'composition',
      chartType: 'stacked_bar',
      source,
      unit: '台',
      data: [
        { quarter: 'Q1', productA: 120, productB: 90, productC: 60 },
        { quarter: 'Q2', productA: 140, productB: 105, productC: 72 },
      ],
      fields: { x: 'quarter', y: ['productA', 'productB', 'productC'] },
    },
  },
  {
    slug: '05-pie',
    input: {
      title: '市场份额',
      goal: 'composition',
      chartType: 'pie',
      source,
      unit: '%',
      data: [
        { company: '甲公司', share: 40 },
        { company: '乙公司', share: 30 },
        { company: '其他', share: 30 },
      ],
      fields: { x: 'company', y: 'share' },
    },
  },
  {
    slug: '06-donut',
    input: {
      title: '缺陷类别占比',
      goal: 'composition',
      chartType: 'donut',
      source,
      unit: '个',
      data: [
        { category: '对位', count: 42 },
        { category: '污染', count: 27 },
        { category: '搬运', count: 18 },
      ],
      fields: { x: 'category', y: 'count' },
    },
  },
  {
    slug: '07-scatter',
    input: {
      title: '温度与良率相关性',
      goal: 'correlation',
      chartType: 'scatter',
      source,
      unit: { temperature: '°C', yield: '%' },
      data: [
        { temperature: 20, yield: 98.2 },
        { temperature: 30, yield: 97.8 },
        { temperature: 40, yield: 96.9 },
      ],
      fields: { x: 'temperature', y: 'yield' },
    },
  },
  {
    slug: '08-histogram',
    input: {
      title: '响应时间分布',
      goal: 'distribution',
      chartType: 'histogram',
      source,
      unit: '次',
      data: [
        { bucket: '0-100ms', count: 58 },
        { bucket: '100-200ms', count: 31 },
        { bucket: '200ms以上', count: 11 },
      ],
      fields: { x: 'bucket', y: 'count' },
    },
  },
  {
    slug: '09-heatmap',
    input: {
      title: '站点与班次故障密度',
      goal: 'distribution',
      chartType: 'heatmap',
      source,
      unit: '个',
      data: [
        { station: 'S1', shift: '白班', failures: 4 },
        { station: 'S1', shift: '夜班', failures: 7 },
        { station: 'S2', shift: '白班', failures: 2 },
        { station: 'S2', shift: '夜班', failures: 5 },
      ],
      fields: { x: 'station', y: 'shift', value: 'failures' },
    },
  },
  {
    slug: '10-boxplot',
    input: {
      title: '批次测试值分布',
      goal: 'distribution',
      chartType: 'boxplot',
      source,
      unit: 'mV',
      data: [
        { lot: 'L1', min: 90, q1: 96, median: 101, q3: 106, max: 112 },
        { lot: 'L2', min: 92, q1: 98, median: 103, q3: 108, max: 115 },
      ],
      fields: { x: 'lot', y: ['min', 'q1', 'median', 'q3', 'max'] },
    },
  },
  {
    slug: '11-pareto',
    input: {
      title: '缺陷原因帕累托分析',
      goal: 'ranking',
      chartType: 'pareto',
      source,
      unit: '个',
      sort: 'desc',
      data: [
        { cause: '对位', count: 42 },
        { cause: '污染', count: 27 },
        { cause: '搬运', count: 18 },
      ],
      fields: { x: 'cause', y: 'count' },
    },
  },
  {
    slug: '12-table',
    input: {
      title: '混合字段汇总表',
      goal: 'compare',
      chartType: 'table',
      source,
      unit: '项',
      data: [
        { project: '项目甲', owner: '张三', count: 120, complete: true },
        { project: '项目乙', owner: '李四', count: 80, complete: false },
      ],
      fields: { x: 'project', y: 'count' },
    },
  },
]

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echarts-use-cases-'))
try {
  for (const testCase of cases) {
    const inputPath = path.join(root, `${testCase.slug}.input.json`)
    fs.writeFileSync(inputPath, JSON.stringify(testCase.input))
    const result = spawnSync(
      process.execPath,
      [
        GENERATOR,
        '--input',
        inputPath,
        '--output-dir',
        root,
        '--slug',
        testCase.slug,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, `${testCase.slug}: ${result.stderr}`)

    const htmlPath = path.join(root, `${testCase.slug}.html`)
    const dataPath = path.join(root, `${testCase.slug}.data.json`)
    const specPath = path.join(root, `${testCase.slug}.spec.json`)
    for (const artifact of [htmlPath, dataPath, specPath]) {
      assert.ok(fs.statSync(artifact).isFile(), `missing ${artifact}`)
    }

    const html = fs.readFileSync(htmlPath, 'utf8')
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
    assert.equal(spec.chartType, testCase.input.chartType)
    assert.ok(Buffer.byteLength(html) < MAX_HTML_BYTES)
    assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=/i)
    assert.doesNotMatch(html, /<link[^>]+\bhref\s*=/i)
    assert.match(html, /document\.body\.dataset\.chartReady='true'/)

    if (testCase.input.chartType === 'histogram') {
      assert.match(
        html,
        /D\.chartType==='histogram'\)return \['histogram','bar','line','area'\]/,
      )
    }
  }
  console.log(`Validated ${cases.length} ECharts HTML use cases`)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

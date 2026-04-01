import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import type {
  Counter,
  Histogram,
  ObservableGauge,
  Meter,
} from '@opentelemetry/api';
import { registerRoute } from './http-server.js';
import { logger } from './logger.js';

let meter: Meter;

// Counters
export let alertsIngestedTotal: Counter;
export let alertsInvestigatedTotal: Counter;
export let containerInvocationsTotal: Counter;

// Histograms
export let alertInvestigationDuration: Histogram;
export let containerDuration: Histogram;

// Gauges (set via callbacks)
let pendingInvestigationsValue = 0;
export function setPendingInvestigations(n: number): void {
  pendingInvestigationsValue = n;
}

let prometheusExporter: PrometheusExporter;

export function initMetrics(): void {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'nanoclaw',
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || 'unknown',
  });

  prometheusExporter = new PrometheusExporter({ preventServerStart: true });

  const readers = [prometheusExporter as any];

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlpEndpoint) {
    const otlpExporter = new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
    });
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: otlpExporter,
        exportIntervalMillis: 60000,
      }),
    );
    logger.info({ endpoint: otlpEndpoint }, 'OTel OTLP exporter enabled');
  }

  const meterProvider = new MeterProvider({ resource, readers });
  meter = meterProvider.getMeter('nanoclaw');

  // Counters
  alertsIngestedTotal = meter.createCounter('alerts_ingested_total', {
    description: 'Total number of alerts ingested',
  });

  alertsInvestigatedTotal = meter.createCounter('alerts_investigated_total', {
    description: 'Total number of alert investigations completed',
  });

  containerInvocationsTotal = meter.createCounter(
    'container_invocations_total',
    {
      description: 'Total number of container agent invocations',
    },
  );

  // Histograms
  alertInvestigationDuration = meter.createHistogram(
    'alert_investigation_duration_seconds',
    {
      description: 'Time from alert received to investigation complete',
      unit: 's',
    },
  );

  containerDuration = meter.createHistogram('container_duration_seconds', {
    description: 'Container agent execution duration',
    unit: 's',
  });

  // Gauge — observed on scrape
  const pendingGauge: ObservableGauge = meter.createObservableGauge(
    'pending_investigations',
    {
      description: 'Number of alerts awaiting investigation',
    },
  );
  pendingGauge.addCallback((result) => {
    result.observe(pendingInvestigationsValue);
  });

  // Register /metrics route on the shared HTTP server
  registerRoute('GET', '/metrics', async (_req, res) => {
    const { text, contentType } = await getMetricsText();
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(text);
  });

  logger.info('Metrics initialised (Prometheus: /metrics)');
}

async function getMetricsText(): Promise<{
  text: string;
  contentType: string;
}> {
  return new Promise((resolve) => {
    const mockReq = {} as any;
    const mockRes = {
      setHeader: () => {},
      end: (text: string) =>
        resolve({
          text,
          contentType: 'text/plain; version=0.0.4; charset=utf-8',
        }),
    } as any;
    prometheusExporter.getMetricsRequestHandler(mockReq, mockRes);
  });
}

import type { ApiModelExecutionTarget } from '@adea-ai/api-client/model-connections'
import { isRecord } from './control-plane-client'

/** Operator-selected destination, not a readiness assertion. CP rechecks target eligibility. */
export function configuredLeadExecutionTarget(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ApiModelExecutionTarget | null {
  if (environment.PI_DURABLE_LEAD_ENABLED !== 'true' || !environment.PI_DURABLE_LEAD_TARGET)
    return null
  try {
    const value: unknown = JSON.parse(environment.PI_DURABLE_LEAD_TARGET)
    if (
      !isRecord(value) ||
      Object.keys(value).toSorted().join(',') !==
        'harness,harnessVersion,location,providerBinding' ||
      value.harness !== 'pi_durable' ||
      value.harnessVersion !== '1.1.0' ||
      value.location !== 'remote_host' ||
      value.providerBinding !== 'pi_durable_models'
    )
      return null
    return {
      harness: 'pi_durable',
      harnessVersion: '1.1.0',
      location: 'remote_host',
      providerBinding: 'pi_durable_models',
    }
  } catch {
    return null
  }
}

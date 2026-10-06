/*
 * Agents & usage tab: one card per provider, newest observation first. Every
 * card names its source; estimates say they are not billing truth, a failed
 * observation shows its typed code, and an unknown quantity stays unknown.
 */
import { For, Show } from 'solid-js'
import { StatusChip } from '@adea-ai/ui/components/ui/status-chip'
import { cn } from '@adea-ai/ui/lib/utils'

import type { UsageCard } from './resources-model'

export function UsageTab(props: { cards: readonly UsageCard[] }) {
  return (
    <div class="dev-resources__tab">
      <section class="dev-resources__group" aria-label="Provider usage">
        <h3 class="dev-resources__group-header">
          <span class="dev-resources__group-title">Provider usage</span>
        </h3>
        <Show
          when={props.cards.length > 0}
          fallback={<p class="dev-resources__note">No usage observations yet.</p>}
        >
          <ul class="dev-resources__list">
            <For each={props.cards}>
              {(card) => (
                <li
                  class={cn('dev-resources__row', {
                    'dev-resources__row--alert': card.failure !== undefined,
                  })}
                >
                  <span class="dev-resources__row-main">
                    <span class="dev-resources__row-title">{card.provider}</span>
                    <span class="dev-resources__row-detail">
                      {card.sourceLabel}
                      <Show when={card.accountLabel}> · {card.accountLabel}</Show>
                    </span>
                    <Show when={card.failure}>
                      {(failure) => (
                        <span class="dev-resources__row-detail dev-resources__row-detail--error">
                          <span class="dev-resources__code">{failure().code}</span>{' '}
                          {failure().message}
                        </span>
                      )}
                    </Show>
                  </span>
                  <span class="dev-resources__usage-value">
                    {card.quantityIsUnknown ? 'unknown' : `${card.quantity} ${card.unit}`}
                    <Show when={card.stale}>
                      <StatusChip tone="warning" label="Stale" compact />
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  )
}

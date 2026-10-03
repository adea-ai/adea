/* Renders the small Markdown tree from model/markdown.ts with Solid text
 * nodes only. Links show their text and keep the address in a tooltip;
 * provider content never becomes HTML or a navigation. */
import { For, Match, Switch, type JSX } from 'solid-js'

import { parseMarkdown, type Block, type Inline } from '../model/markdown'

function Inlines(props: { inlines: readonly Inline[] }): JSX.Element {
  return (
    <For each={props.inlines}>
      {(inline) => (
        <Switch>
          <Match when={inline.kind === 'text' && inline}>{(item) => item().text}</Match>
          <Match when={inline.kind === 'code' && inline}>
            {(item) => <code class="dev-scm-md__code">{item().text}</code>}
          </Match>
          <Match when={inline.kind === 'strong' && inline}>
            {(item) => (
              <strong>
                <Inlines inlines={item().children} />
              </strong>
            )}
          </Match>
          <Match when={inline.kind === 'em' && inline}>
            {(item) => (
              <em>
                <Inlines inlines={item().children} />
              </em>
            )}
          </Match>
          <Match when={inline.kind === 'strike' && inline}>
            {(item) => (
              <s>
                <Inlines inlines={item().children} />
              </s>
            )}
          </Match>
          <Match when={inline.kind === 'link' && inline}>
            {(item) => (
              <span class="dev-scm-md__link" title={item().href}>
                <Inlines inlines={item().children} />
              </span>
            )}
          </Match>
        </Switch>
      )}
    </For>
  )
}

function Blocks(props: { blocks: readonly Block[] }): JSX.Element {
  return (
    <For each={props.blocks}>
      {(block) => (
        <Switch>
          <Match when={block.kind === 'heading' && block}>
            {(item) => (
              <p
                class="dev-scm-md__heading"
                role="heading"
                aria-level={Math.min(6, item().level + 2)}
              >
                <Inlines inlines={item().inlines} />
              </p>
            )}
          </Match>
          <Match when={block.kind === 'paragraph' && block}>
            {(item) => (
              <p class="dev-scm-md__paragraph">
                <Inlines inlines={item().inlines} />
              </p>
            )}
          </Match>
          <Match when={block.kind === 'list' && block}>
            {(item) => {
              const items = () => (
                <For each={item().items}>
                  {(entry) => (
                    <li>
                      {entry.checked === undefined ? '' : entry.checked ? '☑ ' : '☐ '}
                      <Inlines inlines={entry.inlines} />
                    </li>
                  )}
                </For>
              )
              return item().ordered ? (
                <ol class="dev-scm-md__list dev-scm-md__list--ordered">{items()}</ol>
              ) : (
                <ul class="dev-scm-md__list">{items()}</ul>
              )
            }}
          </Match>
          <Match when={(block.kind === 'code' || block.kind === 'table') && block}>
            {(item) => <pre class="dev-scm-md__pre">{(item() as { text: string }).text}</pre>}
          </Match>
          <Match when={block.kind === 'quote' && block}>
            {(item) => (
              <blockquote class="dev-scm-md__quote">
                <Blocks blocks={item().blocks} />
              </blockquote>
            )}
          </Match>
        </Switch>
      )}
    </For>
  )
}

export function RichText(props: { text: string }): JSX.Element {
  return (
    <div class="dev-scm-md">
      <Blocks blocks={parseMarkdown(props.text)} />
    </div>
  )
}

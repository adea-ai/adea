/*
 * A deliberately small Markdown reader for pull request descriptions,
 * comments and reviews. Provider text is untrusted, so this produces a plain
 * block/inline tree that the UI renders through Solid text nodes only —
 * never HTML. Supported: ATX headings, paragraphs, bullet and numbered
 * lists, task items, fenced code, block quotes, pipe tables (kept as
 * preformatted text), and inline code, bold, italic, strikethrough and
 * links (rendered as their text). HTML comments are dropped; any other HTML
 * stays literal text.
 */

export type Inline =
  | Readonly<{ kind: 'text'; text: string }>
  | Readonly<{ kind: 'code'; text: string }>
  | Readonly<{ kind: 'strong' | 'em' | 'strike'; children: readonly Inline[] }>
  | Readonly<{ kind: 'link'; children: readonly Inline[]; href: string }>

export type Block =
  | Readonly<{ kind: 'heading'; level: number; inlines: readonly Inline[] }>
  | Readonly<{ kind: 'paragraph'; inlines: readonly Inline[] }>
  | Readonly<{
      kind: 'list'
      ordered: boolean
      items: readonly Readonly<{ inlines: readonly Inline[]; checked?: boolean }>[]
    }>
  | Readonly<{ kind: 'code'; text: string }>
  | Readonly<{ kind: 'quote'; blocks: readonly Block[] }>
  | Readonly<{ kind: 'table'; text: string }>

const MAX_DEPTH = 4

export function parseInline(text: string, depth = 0): readonly Inline[] {
  const out: Inline[] = []
  let buffer = ''
  const flush = () => {
    if (buffer) out.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    const code = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/)
    if (code) {
      flush()
      out.push({ kind: 'code', text: code[2]!.trim() })
      index += code[0].length
      continue
    }
    if (depth < MAX_DEPTH) {
      const link = rest.match(/^!?\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/)
      if (link) {
        flush()
        if (link[0].startsWith('!'))
          out.push({ kind: 'text', text: link[1] ? `[image: ${link[1]}]` : '[image]' })
        else out.push({ kind: 'link', children: parseInline(link[1]!, depth + 1), href: link[2]! })
        index += link[0].length
        continue
      }
      const strong = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/)
      if (strong) {
        flush()
        out.push({ kind: 'strong', children: parseInline(strong[2]!, depth + 1) })
        index += strong[0].length
        continue
      }
      const strike = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/)
      if (strike) {
        flush()
        out.push({ kind: 'strike', children: parseInline(strike[1]!, depth + 1) })
        index += strike[0].length
        continue
      }
      const em = rest.match(/^([*_])(?=\S)([^*_\n]*?\S)\1(?![*_\w])/)
      if (em && (em[1] === '*' || !/\w/.test(text.charAt(index - 1)))) {
        flush()
        out.push({ kind: 'em', children: parseInline(em[2]!, depth + 1) })
        index += em[0].length
        continue
      }
    }
    buffer += text.charAt(index)
    index += 1
  }
  flush()
  return out
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/

/** Drop HTML comments. Removal repeats until nothing changes, so a comment
 *  split around another (`<!<!---->--`) cannot reassemble, and an
 *  unterminated comment runs to the end of the text, as HTML parses it. */
export function stripComments(text: string): string {
  let current = text
  let previous: string
  do {
    previous = current
    current = current.replace(/<!--[\s\S]*?-->/g, '')
  } while (current !== previous)
  const open = current.indexOf('<!--')
  return open === -1 ? current : current.slice(0, open)
}

export function parseMarkdown(source: string, depth = 0): readonly Block[] {
  const text = stripComments(source.replace(/\r\n?/g, '\n'))
  const lines = text.split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = line.match(/^\s*(```+|~~~+)/)
    if (fence) {
      const close = fence[1]!
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.trimStart().startsWith(close)) {
        body.push(lines[index]!)
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, inlines: parseInline(heading[2]!) })
      index += 1
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      index += 1
      continue
    }
    if (/^\s{0,3}>/.test(line) && depth < MAX_DEPTH) {
      const body: string[] = []
      while (index < lines.length && /^\s{0,3}>/.test(lines[index]!)) {
        body.push(lines[index]!.replace(/^\s{0,3}>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', blocks: parseMarkdown(body.join('\n'), depth + 1) })
      continue
    }
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      index + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}/.test(lines[index + 1]!)
    ) {
      const body: string[] = []
      while (index < lines.length && /^\s*\|/.test(lines[index]!)) {
        body.push(lines[index]!.trim())
        index += 1
      }
      blocks.push({ kind: 'table', text: body.join('\n') })
      continue
    }
    const item = line.match(LIST_ITEM)
    if (item) {
      const ordered = /\d/.test(item[2]!)
      const items: { inlines: readonly Inline[]; checked?: boolean }[] = []
      while (index < lines.length) {
        const current = lines[index]!.match(LIST_ITEM)
        if (current && /\d/.test(current[2]!) === ordered) {
          const task = current[3]!.match(TASK)
          items.push(
            task
              ? { inlines: parseInline(task[2]!), checked: task[1] !== ' ' }
              : { inlines: parseInline(current[3]!) }
          )
          index += 1
          continue
        }
        // A continuation line belongs to the previous item.
        const next = lines[index]!
        if (
          next.trim() !== '' &&
          /^\s{2,}\S/.test(next) &&
          items.length > 0 &&
          !LIST_ITEM.test(next)
        ) {
          const last = items[items.length - 1]!
          items[items.length - 1] = {
            ...last,
            inlines: [...last.inlines, { kind: 'text', text: ' ' }, ...parseInline(next.trim())],
          }
          index += 1
          continue
        }
        if (current) {
          // A nested or differently-ordered list item: keep it as its own text.
          items.push({ inlines: parseInline(current[3]!) })
          index += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index]!.trim() !== '' &&
      !/^\s*(```|~~~)/.test(lines[index]!) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[index]!) &&
      !/^\s{0,3}>/.test(lines[index]!) &&
      !LIST_ITEM.test(lines[index]!)
    ) {
      paragraph.push(lines[index]!.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join('\n')) })
  }
  return blocks
}

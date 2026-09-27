import { render } from 'solid-js/web'
import { Button } from '@adea-ai/ui/components/ui/button'

// The actual published button reads the product document's live theme tokens.
const root = document.createElement('div')
root.id = 'appearance-action-probe'
root.className = 'bg-background'
const panel = document.querySelector('[data-appearance-editor]')
if (!panel) throw new Error('Appearance editor must be mounted before the action probe')
panel.append(root)
render(() => <Button variant="destructive">Destructive action probe</Button>, root)

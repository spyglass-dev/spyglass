/**
 * The dialog's contract is small and entirely about not losing the user's
 * words: what they typed reaches the host together with the widget it was about,
 * and every way of dismissing it closes it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WidgetPromptDialog, type WidgetPromptState } from '../components/WidgetPromptDialog'

afterEach(cleanup)

function setup(state: WidgetPromptState) {
  const onDescribe = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <WidgetPromptDialog
      state={state}
      onOpenChange={onOpenChange}
      onDescribe={onDescribe}
      addSuggestions={['Submissions over time']}
      editSuggestions={['Make it a bar chart']}
    />,
  )
  return { onDescribe, onOpenChange }
}

describe('WidgetPromptDialog', () => {
  it('renders nothing when closed', () => {
    setup(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hands the typed text to the host with the state it was opened on', () => {
    const { onDescribe, onOpenChange } = setup({ mode: 'add' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  scores by group  ' } })
    fireEvent.click(screen.getByText('Add it'))
    expect(onDescribe).toHaveBeenCalledWith('scores by group', { mode: 'add' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('carries the widget index through the edit flow', () => {
    const { onDescribe } = setup({ mode: 'edit', index: 2, label: 'Submissions' })
    expect(screen.getByText(/Change this widget/)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'as a bar chart' } })
    fireEvent.click(screen.getByText('Change it'))
    expect(onDescribe).toHaveBeenCalledWith('as a bar chart', {
      mode: 'edit',
      index: 2,
      label: 'Submissions',
    })
  })

  it('sends a suggestion chip as the request', () => {
    const { onDescribe } = setup({ mode: 'edit', index: 0 })
    fireEvent.click(screen.getByText('Make it a bar chart'))
    expect(onDescribe).toHaveBeenCalledWith('Make it a bar chart', { mode: 'edit', index: 0 })
  })

  it('does not send an empty request', () => {
    const { onDescribe, onOpenChange } = setup({ mode: 'add' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.click(screen.getByText('Add it'))
    expect(onDescribe).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('sends on ⌘↵', () => {
    const { onDescribe } = setup({ mode: 'add' })
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'grading queue' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(onDescribe).toHaveBeenCalledWith('grading queue', { mode: 'add' })
  })

  it('closes on Escape and on a click outside, but not on a click inside', () => {
    const { onOpenChange } = setup({ mode: 'add' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    onOpenChange.mockClear()
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

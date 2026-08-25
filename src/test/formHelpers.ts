import { within } from '@testing-library/react'

/**
 * BUG WORKAROUND, not a recommendation: AdhocTaskFormModal, ClientFormModal,
 * and ClientObligationFormModal render `<label>text</label>` immediately
 * before their `<input>/<select>/<textarea>`, but never wire them together
 * via `htmlFor`/`id` (or by nesting the control inside the label). That
 * means `@testing-library/react`'s `getByLabelText` — and, more
 * importantly, real assistive technology — cannot associate the label with
 * its control. See the tester's report for the accessibility bug writeup;
 * this helper exists only so these tests can still interact with the right
 * field by its visible label text without asserting the (currently broken)
 * accessible-name relationship as if it worked.
 */
export function getControlByLabelText(container: HTMLElement, labelText: string): HTMLElement {
  const labels = within(container).getAllByText(labelText, { selector: 'label' })
  const label = labels[0]
  const control = label.nextElementSibling
  if (!control) {
    throw new Error(`[getControlByLabelText] no sibling form control found after label "${labelText}"`)
  }
  return control as HTMLElement
}

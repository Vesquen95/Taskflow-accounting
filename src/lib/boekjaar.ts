/** "30/06" uit maand 6 en dag 30.
 *
 *  De databank bewaart het boekjaareinde als twee getallen, want een
 *  boekjaareinde is geen datum: het herhaalt zich elk jaar. Op het scherm
 *  hoort het er wél als een dag-en-maand uit te zien. */
export function boekjaarLabel(maand: number, dag: number): string {
  return `${String(dag).padStart(2, '0')}/${String(maand).padStart(2, '0')}`
}

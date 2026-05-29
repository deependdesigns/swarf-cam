import { grbl } from './grbl'
import { mach3 } from './mach3'
import { linuxcnc } from './linuxcnc'

export const POST_PROCESSORS = { grbl, mach3, linuxcnc }

export function getPostProcessor(id) {
  return POST_PROCESSORS[id] ?? grbl
}

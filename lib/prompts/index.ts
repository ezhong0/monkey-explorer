// Re-export the @inquirer/prompts primitives we use, with a thin wrapper
// that throws a sentinel error on Ctrl+C so callers can distinguish
// "user aborted" from "validation rejected".

import {
  input as rawInput,
  password as rawPassword,
  select as rawSelect,
  confirm as rawConfirm,
} from '@inquirer/prompts';

export const input = rawInput;
export const password = rawPassword;
export const select = rawSelect;
export const confirm = rawConfirm;

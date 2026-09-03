#!/usr/bin/env node
// Setup test operators for concurrent edit verification

import { createCaseStore } from './src/case-store.js'
import { hashPassword, createAccount } from './src/dashboard/auth.js'

const store = await createCaseStore({cwd: process.cwd()})
await store.init()

// Insert two test operators
const op1Name = 'operator_a'
const op1Pass = 'password_a_12345'

const op2Name = 'operator_b'
const op2Pass = 'password_b_12345'

try {
  // Create operators via the auth API
  const result1 = await createAccount(store, {
    username: op1Name,
    password: op1Pass,
    display_name: 'Operator A',
    role: 'operator'
  })

  const result2 = await createAccount(store, {
    username: op2Name,
    password: op2Pass,
    display_name: 'Operator B',
    role: 'operator'
  })

  console.log(`Created test operators:`)
  console.log(`  1. ${op1Name} / ${op1Pass}`)
  console.log(`  2. ${op2Name} / ${op2Pass}`)
  console.log(`Result 1:`, result1)
  console.log(`Result 2:`, result2)
} catch (e) {
  console.error('Error setting up operators:', e.message)
  process.exit(1)
}

process.exit(0)

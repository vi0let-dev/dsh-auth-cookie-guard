/**
 * Runs every test file in one process.
 *
 * `node --test` spawns one child per file, which some sandboxes refuse
 * (`spawn EPERM`); importing the files directly keeps the run in-process.
 */

import './core.test.mjs'
import './route.test.mjs'
import './settings.test.mjs'
import './sqlite.test.mjs'
import './client.test.mjs'

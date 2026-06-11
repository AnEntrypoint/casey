// casey case-tools plugin - registers the case_* tools into freddie's host so
// the agent can use them in any runTurn. Discovered by bootHost when casey
// passes C:/dev/casey/plugins as an extra plugin root. Handlers resolve the
// shared CaseStore lazily via case-runtime, so this loads fine even before the
// store is initialised.
import { buildCaseToolset } from '../../src/case-tools.js'

export default {
  name: 'casey-case-tools',
  surfaces: 'pi',
  register({ pi }) {
    for (const tool of buildCaseToolset(null)) pi.tools.register(tool)
  },
}

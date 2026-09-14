import { main } from './server'

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

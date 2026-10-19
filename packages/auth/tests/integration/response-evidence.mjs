// Failure evidence for the built-Worker harness. It never echoes response text: a successful
// sign-up or sign-in body carries a session token, so only the status, fixed headers and a
// fixed body category leave this function.
const errorCode = /^[A-Z][A-Z_]{0,39}$/

export function describeResponse(result) {
  const text = result.text ?? ''
  let bodyCategory = 'empty'
  if (text.length > 0) {
    if (result.status >= 200 && result.status < 300) {
      bodyCategory = 'success'
    } else {
      let code
      try {
        code = JSON.parse(text)?.code
      } catch {
        code = undefined
      }
      bodyCategory = typeof code === 'string' && errorCode.test(code) ? `error:${code}` : 'error'
    }
  }
  return {
    status: result.status,
    connection: result.headers?.connection ?? null,
    cacheControl: result.headers?.['cache-control'] ?? null,
    bodyCategory,
  }
}

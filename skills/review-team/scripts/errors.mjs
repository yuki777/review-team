const errorKinds = [
  ['sandbox_error', /(?:failed|unable) to (?:apply|initialize|start|enable).*sandbox|sandbox[^\n]*(?:failed|unavailable|not supported|disabled)|continuing without (?:a )?sandbox/i],
  ['network_error', /ECONN(?:RESET|REFUSED)|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network (?:error|unreachable)|connection (?:error|reset|refused)|\b(?:429|502|503|504)\b|rate[_ -]limit|service unavailable/i],
  ['model_unavailable', /model[_ -]not[_ -]found|model[^\n]*requires a newer version|(?:model|deployment)[^\n]*(?:does not exist|not found|not available|not recognized|unavailable|not supported|unsupported|access denied)|(?:no access|not have access|unsupported)[^\n]*model/i],
  ['auth_error', /\b401\b|\b403\b|unauthorized|unauthenticated|invalid (?:api[ _-]?key|token|credentials)|authentication (?:failed|required)|not (?:logged|signed) in|(?:run|please)[^\n]*\blogin\b|missing[^\n]*(?:api[ _-]?key|credentials)/i],
];

export function classifyError(message) {
  return errorKinds.find(([, pattern]) => pattern.test(message))?.[0] ?? 'error';
}

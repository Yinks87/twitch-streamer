export const parseTemplate = (template, variables) => {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => variables[key] || '');
};

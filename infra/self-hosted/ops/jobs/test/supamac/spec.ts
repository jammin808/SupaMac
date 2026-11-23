// The storage service's OpenAPI document, and a small JSON Schema checker
// for the parts of it the service's requests and answers use.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ApiRequest } from '../../src/supamac/client';

export const SPEC_PATH = resolve(
  import.meta.dir,
  '../../../../../../packages/sdk/specs/storage.json'
);

type Json = Record<string, unknown>;

export const SPEC = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Json;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deref(schema: unknown): unknown {
  let current = schema;
  for (
    let depth = 0;
    isObject(current) && typeof current.$ref === 'string';
    depth++
  ) {
    if (depth > 50) throw new Error('reference loop');
    const ref = current.$ref as string;
    if (!ref.startsWith('#/')) throw new Error(`unsupported reference ${ref}`);
    let target: unknown = SPEC;
    for (const part of ref.slice(2).split('/')) {
      target = isObject(target) ? target[part] : undefined;
    }
    if (target === undefined) throw new Error(`unresolved reference ${ref}`);
    current = target;
  }
  return current;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    default:
      throw new Error(`unsupported type ${type}`);
  }
}

/** Every way `value` breaks `schema`; empty when it fits. */
export function validate(
  schemaIn: unknown,
  value: unknown,
  path = '$'
): string[] {
  const schema = deref(schemaIn);
  if (schema === true || schema === undefined) return [];
  if (!isObject(schema)) throw new Error(`not a schema at ${path}`);
  const errors: string[] = [];
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf)
      errors.push(...validate(part, value, path));
  }
  if (Array.isArray(schema.oneOf)) {
    const discriminator = isObject(schema.discriminator)
      ? schema.discriminator
      : undefined;
    if (
      discriminator !== undefined &&
      isObject(value) &&
      isObject(discriminator.mapping)
    ) {
      const tag = value[discriminator.propertyName as string];
      const target =
        typeof tag === 'string' ? discriminator.mapping[tag] : undefined;
      if (typeof target !== 'string')
        errors.push(
          `${path}: no ${String(discriminator.propertyName)} mapping for ${String(tag)}`
        );
      else errors.push(...validate({ $ref: target }, value, path));
    } else {
      const fits = schema.oneOf.filter(
        (part) => validate(part, value, path).length === 0
      ).length;
      if (fits !== 1) {
        const detail = schema.oneOf
          .map((part) => validate(part, value, path).slice(0, 2).join('; '))
          .join(' | ');
        errors.push(`${path}: fits ${fits} of oneOf (${detail})`);
      }
    }
  }
  if (Array.isArray(schema.anyOf)) {
    if (
      !schema.anyOf.some((part) => validate(part, value, path).length === 0)
    ) {
      errors.push(`${path}: fits none of anyOf`);
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(
      `${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`
    );
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string];
    if (!types.some((t) => typeOk(t, value))) {
      errors.push(
        `${path}: ${JSON.stringify(value)?.slice(0, 80)} is not ${types.join(' or ')}`
      );
      return errors;
    }
  }
  if (
    typeof value === 'string' &&
    schema.format === 'uuid' &&
    !UUID_RE.test(value)
  ) {
    errors.push(`${path}: ${value} is not a uuid`);
  }
  if (
    typeof value === 'string' &&
    schema.format === 'date-time' &&
    Number.isNaN(Date.parse(value))
  ) {
    errors.push(`${path}: ${value} is not a date-time`);
  }
  if (
    typeof value === 'number' &&
    typeof schema.minimum === 'number' &&
    value < schema.minimum
  ) {
    errors.push(`${path}: ${value} is under ${schema.minimum}`);
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in value)) errors.push(`${path}: missing ${key}`);
      }
    }
    for (const [key, v] of Object.entries(value)) {
      if (key in properties)
        errors.push(...validate(properties[key], v, `${path}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unexpected ${key}`);
      else if (isObject(schema.additionalProperties)) {
        errors.push(
          ...validate(schema.additionalProperties, v, `${path}.${key}`)
        );
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      errors.push(...validate(schema.items, item, `${path}[${i}]`));
    });
  }
  return errors;
}

export function operation(method: string, template: string): Json {
  const paths = SPEC.paths as Json;
  const item = paths[template];
  if (!isObject(item)) throw new Error(`the spec has no path ${template}`);
  const op = item[method.toLowerCase()];
  if (!isObject(op)) throw new Error(`the spec has no ${method} ${template}`);
  return op;
}

/** Every way a request breaks its route's contract; empty when it fits. */
export function checkRequest(request: ApiRequest<unknown>): string[] {
  const paths = SPEC.paths as Json;
  const item = paths[request.template];
  if (!isObject(item) || !isObject(item[request.method.toLowerCase()])) {
    return [`the spec has no ${request.method} ${request.template}`];
  }
  const op = operation(request.method, request.template);
  const errors: string[] = [];
  const parameters = (Array.isArray(op.parameters) ? op.parameters : []).map(
    (p) => deref(p) as Json
  );
  const placeholders = [...request.template.matchAll(/\{([^}]+)\}/g)].map(
    (m) => m[1] as string
  );
  for (const name of placeholders) {
    const declared = parameters.find((p) => p.in === 'path' && p.name === name);
    if (declared === undefined) errors.push(`path {${name}} is not declared`);
    const value = request.params[name];
    if (value === undefined) errors.push(`path {${name}} has no value`);
    else if (declared !== undefined)
      errors.push(...validate(declared.schema, value, `path.${name}`));
  }
  for (const name of Object.keys(request.params)) {
    if (!placeholders.includes(name))
      errors.push(`param ${name} is not in the template`);
  }
  for (const p of parameters.filter((p) => p.in === 'path')) {
    if (!placeholders.includes(p.name as string))
      errors.push(`declared path ${String(p.name)} not in template`);
  }
  for (const [name, value] of Object.entries(request.query)) {
    const declared = parameters.find(
      (p) => p.in === 'query' && p.name === name
    );
    if (declared === undefined) {
      errors.push(`query ${name} is not declared`);
      continue;
    }
    const schema = deref(declared.schema) as Json;
    const typed = schema.type === 'integer' ? Number(value) : value;
    if (schema.type === 'integer' && !/^-?\d+$/.test(value))
      errors.push(`query ${name} is not an integer`);
    errors.push(...validate(schema, typed, `query.${name}`));
  }
  for (const p of parameters.filter(
    (p) => p.in === 'query' && p.required === true
  )) {
    if (!(String(p.name) in request.query))
      errors.push(`required query ${String(p.name)} is missing`);
  }
  const requestBody = isObject(op.requestBody)
    ? (deref(op.requestBody) as Json)
    : undefined;
  if (request.body === undefined) {
    if (requestBody?.required === true)
      errors.push('the route requires a body');
  } else if (requestBody === undefined) {
    errors.push('the route takes no body');
  } else {
    const content = requestBody.content as Json;
    if (request.body.kind === 'bytes') {
      if (!('application/octet-stream' in content))
        errors.push('the route takes no octet-stream body');
    } else {
      const json = content['application/json'];
      if (!isObject(json)) errors.push('the route takes no JSON body');
      else
        errors.push(
          ...validate(
            json.schema,
            JSON.parse(JSON.stringify(request.body.value)),
            'body'
          )
        );
    }
  }
  return errors;
}

/** Every way an answer breaks the route's documented answer for a status. */
export function checkResponse(
  method: string,
  template: string,
  status: number,
  body: unknown
): string[] {
  const op = operation(method, template);
  const responses = op.responses as Json;
  const response = deref(responses[String(status)]);
  if (!isObject(response)) return [`no ${status} answer is documented`];
  const content = isObject(response.content) ? response.content : undefined;
  const json = content?.['application/json'];
  if (!isObject(json))
    return body === null ? [] : [`no JSON ${status} answer is documented`];
  return validate(json.schema, body, 'response');
}

/** The statuses a route documents. */
export function documentedStatuses(method: string, template: string): number[] {
  return Object.keys(operation(method, template).responses as Json).map(Number);
}

import { describe, expect, test } from 'bun:test';
import { webAppBase, webAppLink } from './web-app';

describe('web app links', () => {
  test('an origin alone serves the app at /app', () => {
    expect(webAppBase('https://team.example.com')).toEqual({
      origin: 'https://team.example.com',
      basePath: '/app',
    });
    expect(webAppLink('http://localhost:3000/', '/md/1')).toBe(
      'http://localhost:3000/app/md/1',
    );
  });

  test('a path after the origin is the base path', () => {
    expect(webAppBase('https://team.example.com/workspace/')).toEqual({
      origin: 'https://team.example.com',
      basePath: '/workspace',
    });
    expect(webAppLink('https://team.example.com/workspace', '/book/p/s')).toBe(
      'https://team.example.com/workspace/book/p/s',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { FEEDBACK_PAGE_URL, buildIssueUrl } from './feedback';

describe('feedback', () => {
  it('points at the project issue tracker', () => {
    expect(FEEDBACK_PAGE_URL).toMatch(/^https:\/\/github\.com\/.+\/issues\/new$/);
  });

  it('prefills title and body as query params', () => {
    const url = buildIssueUrl('Crash on extrude', 'SceneLab v0.25.0\nWindows');
    expect(url.startsWith(`${FEEDBACK_PAGE_URL}?`)).toBe(true);
    // URLSearchParams encodes spaces as '+' — valid query syntax GitHub accepts.
    expect(url).toContain('title=Crash+on+extrude');
    expect(url).toContain('body=SceneLab+v0.25.0');
  });

  it('encodes newlines in the body so the URL stays single-line', () => {
    const url = buildIssueUrl('t', 'a\nb');
    expect(url).not.toContain('\n');
    expect(url).toContain(encodeURIComponent('\n'));
  });
});

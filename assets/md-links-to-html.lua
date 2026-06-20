-- md-links-to-html.lua
-- Rewrite intra-corpus Markdown links (foo.md, foo.md#anchor) to their built
-- .html targets, so the generated HTML cross-links resolve. Pandoc emits link
-- targets verbatim, so without this filter every internal link would still point
-- at a .md file that the browser cannot open.
--
-- The build mirrors the repo tree under html/ (html/guides/**, html/docs/adr/**),
-- so a relative .md link resolves to the matching .html once the extension is
-- rewritten -- including the guides' ../docs/adr/ cross-references.
--
-- Left untouched on purpose:
--   - external/absolute URLs (https://, mailto:, //host, /root-absolute)
--   - pure in-page anchors (#section)

function Link(el)
  local target = el.target
  if not target or target == '' then return nil end

  -- scheme (https:, mailto:, etc.), protocol-relative, root-absolute, or anchor-only
  if target:find('^%a[%w+.%-]*:') or target:find('^//') or target:find('^/') or target:find('^#') then
    return nil
  end

  -- split path from #fragment (this corpus does not use ?query)
  local path, frag = target:match('^([^#]*)(#?.*)$')
  local newpath, n = path:gsub('%.md$', '.html')
  if n > 0 then
    el.target = newpath .. frag
    return el
  end

  return nil
end

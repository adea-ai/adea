# Interior package

This package combines Agent HQ's interior room layout, room-designer prop
types/runtime, interior model catalog, and validation schemas. Its assets are
organized by room-designer folder, including dedicated Bathroom,
Kitchen, Entertainment, Recreation, Rugs, Retail, Fitness, Kids, and
Wall Art categories for the expanded interior collection plus separate `food/`
and `drinks/` folders behind the combined Food & Drinks editor category. Fully
authored room scenes live in `@agent-hq/rooms`.

Use `@agent-hq/interior/room-config` for lightweight HQ geometry constants; it
intentionally does not import the editor catalog. The normal HQ scene receives
assigned prop URLs through the generated `props-runtime.json` manifest, while
`@agent-hq/room-designer-scene` owns the complete catalog.

Exterior foliage, trees, and fences belong to `@agent-hq/landscape` instead.
Architecture assets belong to `@agent-hq/architecture` instead.

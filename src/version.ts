// ask's version, from package.json, which releases set from the tag.

import pkg from "../package.json" with { type: "json" }

export const version: string = pkg.version

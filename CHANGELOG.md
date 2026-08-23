# Changelog

## [0.2.2](https://github.com/0xPlayerOne/agent-hq/compare/agent-hq-v0.2.1...agent-hq-v0.2.2) (2026-08-23)


### CI

* align Code Foundry merge policy ([#88](https://github.com/0xPlayerOne/agent-hq/issues/88)) ([6fc4ccc](https://github.com/0xPlayerOne/agent-hq/commit/6fc4cccc5b0f893d49e4f2be85c5746712f64c18))

## [0.2.1](https://github.com/0xPlayerOne/agent-hq/compare/agent-hq-v0.2.0...agent-hq-v0.2.1) (2026-08-23)


### Bug Fixes

* include Tauri bundle icons ([c5636a7](https://github.com/0xPlayerOne/agent-hq/commit/c5636a792163ea8da089cfc205180ca94c007d7a))
* run release version alignment in bash ([#80](https://github.com/0xPlayerOne/agent-hq/issues/80)) ([b1a4435](https://github.com/0xPlayerOne/agent-hq/commit/b1a4435321198cea2d989cd0a2c195676103a4d5))


### CI

* harden desktop releases and dependency updates ([8869f88](https://github.com/0xPlayerOne/agent-hq/commit/8869f884fd1b89d9eeea3f23570fab65b368a8ca))

## [0.2.0](https://github.com/0xPlayerOne/agent-hq/compare/agent-hq-v0.1.0...agent-hq-v0.2.0) (2026-08-23)


### Features

* **core:** add shared application contracts and state ([bcd4287](https://github.com/0xPlayerOne/agent-hq/commit/bcd428794c570ad618300dfe3a7fb1f2758943dd))
* **core:** exercise shared data and state boundaries ([cdf1041](https://github.com/0xPlayerOne/agent-hq/commit/cdf1041265a75871d13006548c69d4725daff1fa))
* **hq:** add bounded camera zoom controls ([44a4723](https://github.com/0xPlayerOne/agent-hq/commit/44a47236dd471b26bf6d66e53d2bfe76d6f839df))
* **hq:** keep scenes on the ithappy asset boundary ([029ffe4](https://github.com/0xPlayerOne/agent-hq/commit/029ffe483de25ba426670711bbd0cca4fa5e1f2f))
* **hq:** migrate spatial workspace runtime ([7a9315d](https://github.com/0xPlayerOne/agent-hq/commit/7a9315d7b0886760257f5901c5f003bab3753a65))
* **hq:** move camera controls to workspace footer ([1405503](https://github.com/0xPlayerOne/agent-hq/commit/140550394125ebee4dd0053918fd45eaa49e34b4))
* **hq:** move character selection into account drawer ([442bdd5](https://github.com/0xPlayerOne/agent-hq/commit/442bdd5165d7fbf192f9dbb8afe9958648c5e55a))
* **hq:** move room designer to header actions ([9ca064d](https://github.com/0xPlayerOne/agent-hq/commit/9ca064d328cc25997a47abc88a0716a38ca63647))
* **hq:** place room designer on secondary header row ([d22155b](https://github.com/0xPlayerOne/agent-hq/commit/d22155b0015866d108e6be56b47f21479ea0692e))
* **hq:** restore unified workspace shell ([c5ab15c](https://github.com/0xPlayerOne/agent-hq/commit/c5ab15c28b05dac14ef57c48c4284bfee3d4fcd8))
* **hq:** streamline scene controls and overlays ([df956ec](https://github.com/0xPlayerOne/agent-hq/commit/df956ec17d9c70b027860c6229dc5e6384719977))
* initialize Agent HQ frontend workspace ([86f307a](https://github.com/0xPlayerOne/agent-hq/commit/86f307a9fc7cecb1e2da9f35adb5483fa9d0e6b7))
* **platforms:** add desktop mobile shells and scene core ([8f86371](https://github.com/0xPlayerOne/agent-hq/commit/8f863716f1f21537b58b28565ae88963e6b344ef))
* **platforms:** restore native shells and shared config ([6a4ce1c](https://github.com/0xPlayerOne/agent-hq/commit/6a4ce1ca4f1e6efd3cd22459382ab5f4711aac54))
* **scene-editor:** restore perspective toolbar toggle ([4818a95](https://github.com/0xPlayerOne/agent-hq/commit/4818a95e532eef857f70335e88befdf5fcd8f445))


### Bug Fixes

* **hq:** add breathing room to header selector row ([2c2e588](https://github.com/0xPlayerOne/agent-hq/commit/2c2e588845a348f6b22b3f087f2eeb772f234df4))
* **hq:** add top spacing to selector row ([34fceb5](https://github.com/0xPlayerOne/agent-hq/commit/34fceb5e89520b7235b5c95c446d4aabe3c4e2a9))
* **hq:** align road and interior scene surfaces ([a908349](https://github.com/0xPlayerOne/agent-hq/commit/a908349715639754c2b6a44584a4bcc972e03cdb))
* **hq:** attach editor panels to tool triggers ([c3f9a07](https://github.com/0xPlayerOne/agent-hq/commit/c3f9a073a11ecc69ff076b5c578a3f55f103fc02))
* **hq:** complete road sidewalk and wall finish ([7692127](https://github.com/0xPlayerOne/agent-hq/commit/7692127108c45a92e22016e18e14bd898de0042e))
* **hq:** extend cement frontage through designer view ([b385530](https://github.com/0xPlayerOne/agent-hq/commit/b385530f06c7eb553e1f7fbd2da94070f30b5df9))
* **hq:** frame full fence perimeter ([34ed51a](https://github.com/0xPlayerOne/agent-hq/commit/34ed51a3aa155af2c238a676b795df7e4e3b3dd4))
* **hq:** frame street frontage below workspace bar ([603f77f](https://github.com/0xPlayerOne/agent-hq/commit/603f77f70e7a6fd0374d8aa9c3eaf3c25bd062fd))
* **hq:** keep camera clear and close fence gate ([8c487a4](https://github.com/0xPlayerOne/agent-hq/commit/8c487a4dd1849f4d82396d6fe23cbb88b9243fc8))
* **hq:** keep camera switches in the live scene ([82d7900](https://github.com/0xPlayerOne/agent-hq/commit/82d7900649a0310a2c51584fca5cb07345062935))
* **hq:** keep map selectors left in header row ([e5fd68f](https://github.com/0xPlayerOne/agent-hq/commit/e5fd68f5e796333e3d26180568ba71bac64fed3f))
* **hq:** raise exterior room walls ([1a6d40c](https://github.com/0xPlayerOne/agent-hq/commit/1a6d40c61f1028b6bc3e15e3898485d6bb4b5fe0))
* **hq:** render walls and save editor changes ([5f722ce](https://github.com/0xPlayerOne/agent-hq/commit/5f722cee50241b67117ea1f34e23d436b344a247))
* **hq:** restore centered scene framing and cement frontage ([502414a](https://github.com/0xPlayerOne/agent-hq/commit/502414a9d24c9e7d611a8db2ed0fd2361c6645cf))
* **hq:** right align room designer with scene selectors ([bdede70](https://github.com/0xPlayerOne/agent-hq/commit/bdede7074ce371195943edbfb2830141016ca80f))
* **hq:** stabilize scene loading callbacks ([7d9a2b7](https://github.com/0xPlayerOne/agent-hq/commit/7d9a2b765d7eae9889292673028fd4d9700fbfdc))
* **hq:** use environment loading fallback ([51f5221](https://github.com/0xPlayerOne/agent-hq/commit/51f5221b594b413d80356cdb4c5a93bce80dfb7d))
* resolve performance review comments ([a8d9b3a](https://github.com/0xPlayerOne/agent-hq/commit/a8d9b3a70ca1651052c00f1f8fe36c3caf78edf2))
* **room-designer:** hide inactive reset action ([dafc1de](https://github.com/0xPlayerOne/agent-hq/commit/dafc1de791dc3f925e6ac599cb445b574caced34))
* **scene-shell:** clean shared collider imports ([855ce46](https://github.com/0xPlayerOne/agent-hq/commit/855ce46498bbef13d23451b4ff0d17d98ad0f231))
* **ui:** align room designer action variants ([b593c14](https://github.com/0xPlayerOne/agent-hq/commit/b593c1405c79b1af79108d95bd489726f817a919))
* **ui:** keep touch actions focused on jump ([2682db3](https://github.com/0xPlayerOne/agent-hq/commit/2682db34d12c535e5197adb690d1b29797918abe))


### Performance

* add measurable HQ runtime and validation gates ([fa2e36e](https://github.com/0xPlayerOne/agent-hq/commit/fa2e36e7769af2cb57b353074e1caf704091b5e1))
* add scene load cancellation and asset budgets ([21044ac](https://github.com/0xPlayerOne/agent-hq/commit/21044ac7b7844a1fec0f931646b1fb18aabb7004))
* **assets:** serve HQ materials as WebP ([58033b0](https://github.com/0xPlayerOne/agent-hq/commit/58033b0a8e943556666fd108a263bcc51f90a83b))
* compress runtime character and landscape assets ([5d7e1fe](https://github.com/0xPlayerOne/agent-hq/commit/5d7e1fedca322e072d849893948a7e33c1da9b50))
* **hq:** reuse scene materials ([a060e84](https://github.com/0xPlayerOne/agent-hq/commit/a060e844ee147678f1e7fcc7464b48d90beccf6a))
* **hq:** scale client state and scene runtime ([e8fdadf](https://github.com/0xPlayerOne/agent-hq/commit/e8fdadfd291930a33f756e29298143babef94362))
* instrument HQ runtime and validation gates ([69466a3](https://github.com/0xPlayerOne/agent-hq/commit/69466a366024e7238282b917bcae5e889de976c2))
* **interior:** keep field runtime out of root entrypoint ([77c6b5e](https://github.com/0xPlayerOne/agent-hq/commit/77c6b5e3ef9af7d3d09da26081cddc94cf8b1137))
* optimize HQ scene foundation ([93fc2cb](https://github.com/0xPlayerOne/agent-hq/commit/93fc2cb25aa9fb30c86cbbd61a98a600c3acd0c5))
* restore native smoke builds and basis normal maps ([c3f2b66](https://github.com/0xPlayerOne/agent-hq/commit/c3f2b6678d202bb32ec36a32e11098536df4b7e1))
* **scene-shell:** share room placement loading ([d40cb22](https://github.com/0xPlayerOne/agent-hq/commit/d40cb22c2a545237f43ff76b88dfb22375f313f0))
* **scene:** defer props and remove api polling ([128b77e](https://github.com/0xPlayerOne/agent-hq/commit/128b77e67f4fa6db3d889b9e2634b2445ae84994))
* **web:** isolate package validation schemas ([44a5f8f](https://github.com/0xPlayerOne/agent-hq/commit/44a5f8f1599304d4bbc64f6ae38e8862b8b04c49))
* **web:** lazy load home ambient pets ([dd0c761](https://github.com/0xPlayerOne/agent-hq/commit/dd0c761ce24044a9acf412999c4b13de52d5fa95))
* **web:** share grass perimeter and split UI imports ([76db328](https://github.com/0xPlayerOne/agent-hq/commit/76db32816d4ade7d330374143353948aec57e7e1))


### CI

* enable Code Foundry and desktop releases ([#76](https://github.com/0xPlayerOne/agent-hq/issues/76)) ([c45778f](https://github.com/0xPlayerOne/agent-hq/commit/c45778f34bd8cb218bc6b66055b0fff64bcc5f90))


### Maintenance

* **agents:** add shadcn and threejs skills ([080203d](https://github.com/0xPlayerOne/agent-hq/commit/080203d2ff43cc9331ffc5e8205cbb4088c704de))
* **assets:** move character assets into character package ([f0ff755](https://github.com/0xPlayerOne/agent-hq/commit/f0ff75535083ff1cbdc6d33bf05ecab7280fe23d))
* **assets:** remove unused HQ rock texture ([c1048a0](https://github.com/0xPlayerOne/agent-hq/commit/c1048a0e9a1dcc7491a3f4ab9d71db02c7c7233c))
* **characters:** own character runtime and catalogs ([898a98e](https://github.com/0xPlayerOne/agent-hq/commit/898a98ecd6bed5bc5a83aa24fd2504f91641e63b))
* **deps:** update workspace dependencies ([20e115f](https://github.com/0xPlayerOne/agent-hq/commit/20e115f7498c0a37b96317750c1d5b80cf5ea352))
* **dev:** configure Portless development routing ([f1d3ef9](https://github.com/0xPlayerOne/agent-hq/commit/f1d3ef989de4915cb12afe2ba74dfffc48abf9ca))
* **hq:** promote scene editing controls ([b0ec54f](https://github.com/0xPlayerOne/agent-hq/commit/b0ec54fc8e2301d4738d146b2a2ca70d6112e51d))
* **hq:** prune world-only runtime and rename model catalog ([b43246f](https://github.com/0xPlayerOne/agent-hq/commit/b43246f86504ff57cbb385f1be9aa3e83b2b2d55))
* **hq:** remove unauthorized floorplan migration ([42c20b5](https://github.com/0xPlayerOne/agent-hq/commit/42c20b5fbb7e1ae3b95dccd3d6c18c61ec39963e))
* **interior:** combine room prop and model packages ([3a5a05b](https://github.com/0xPlayerOne/agent-hq/commit/3a5a05b09557c287968a8fcdf0900a9f9d195132))
* **interior:** organize room designer assets ([91fc6a5](https://github.com/0xPlayerOne/agent-hq/commit/91fc6a51955111206171390829fcd6b1a7668d26))
* **landscape:** own exterior foliage and fences ([f51ab3b](https://github.com/0xPlayerOne/agent-hq/commit/f51ab3b55aefc1cabf1b9b9c559eb3e76a0889f8))
* migrate skills to .agents/skills/ for team sharing ([#75](https://github.com/0xPlayerOne/agent-hq/issues/75)) ([5c0ba16](https://github.com/0xPlayerOne/agent-hq/commit/5c0ba164cbdf7e3501b40bbffbe74a2509bc9779))
* **pets:** own ambient animal assets and runtime ([4ca2a0a](https://github.com/0xPlayerOne/agent-hq/commit/4ca2a0a4b0e3a68c1f8d12f1ddd16d0de221eebc))
* **release:** track interior package ([bc72bcf](https://github.com/0xPlayerOne/agent-hq/commit/bc72bcf10dd84cc56cda492e0032728e5fc29de1))
* remove generated web agent instructions ([0817c66](https://github.com/0xPlayerOne/agent-hq/commit/0817c669d2fd691dd1ce16f7e0de5429e517db57))
* remove legacy HQ surfaces and generated scaffolding ([1c53e5f](https://github.com/0xPlayerOne/agent-hq/commit/1c53e5f1f669474c1ed27e3fb34e5a41bbbedbc6))
* remove stale web agent instructions ([86c1131](https://github.com/0xPlayerOne/agent-hq/commit/86c113149bf5c048c5117fc929171f2173d1659b))
* remove unused scene compatibility props ([f3d785c](https://github.com/0xPlayerOne/agent-hq/commit/f3d785c14e3fe402754c8f253f82ea4bf3b3f01e))
* rename scene field loader and document packages ([f3cff59](https://github.com/0xPlayerOne/agent-hq/commit/f3cff594c1be7978143e960c1a35dbe1a940bc92))
* **repo:** align configuration and licensing ([75e1a3c](https://github.com/0xPlayerOne/agent-hq/commit/75e1a3cd29e5a3ab620e337af50a0495cea8a1a0))
* **repo:** disable dependabot automation ([f2dbcc3](https://github.com/0xPlayerOne/agent-hq/commit/f2dbcc31f1fe6895143cad8ec415968612c0c9c2))
* **repo:** initialize code-foundry baseline ([b8a5f58](https://github.com/0xPlayerOne/agent-hq/commit/b8a5f58b04299588b60e6a1c446c41bfa870b378))
* **repo:** rename hq app to web ([e02870b](https://github.com/0xPlayerOne/agent-hq/commit/e02870b227bc5753df9bf033c27533e743902e92))
* **runtime:** remove unused particle system ([3de2ad7](https://github.com/0xPlayerOne/agent-hq/commit/3de2ad78312a2bea4de00770f6e5f4ff0ac9f13f))
* **runtime:** remove unused scene package ([c785259](https://github.com/0xPlayerOne/agent-hq/commit/c785259bd7d3ae40e70796fa2ad0b8023affae53))
* **scene:** clarify editor query behavior ([f18aa19](https://github.com/0xPlayerOne/agent-hq/commit/f18aa1903ce84c681730d8f463e7b922dc4b5483))
* **scenes:** combine HQ scene packages ([f997f5b](https://github.com/0xPlayerOne/agent-hq/commit/f997f5bd0603530400bf2ec74254a9290dc1013c))
* **scenes:** consolidate HQ scene definitions ([1847944](https://github.com/0xPlayerOne/agent-hq/commit/184794462102a1d3d50005d2f65c26afa13bd07e))
* **ui:** use shared Base UI buttons ([9c40c1e](https://github.com/0xPlayerOne/agent-hq/commit/9c40c1e3357c678923f82fbcacb2138abb80aa3a))
* **web:** ignore generated Next type shim ([682b5a6](https://github.com/0xPlayerOne/agent-hq/commit/682b5a69a30783cdc1a65079d6fc32f79f9fa8ed))

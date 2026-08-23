# Changelog

## [0.2.0](https://github.com/0xPlayerOne/agent-hq/compare/web-v0.1.0...web-v0.2.0) (2026-08-23)


### Features

* **core:** add shared application contracts and state ([bcd4287](https://github.com/0xPlayerOne/agent-hq/commit/bcd428794c570ad618300dfe3a7fb1f2758943dd))
* **core:** exercise shared data and state boundaries ([cdf1041](https://github.com/0xPlayerOne/agent-hq/commit/cdf1041265a75871d13006548c69d4725daff1fa))
* **hq:** add bounded camera zoom controls ([44a4723](https://github.com/0xPlayerOne/agent-hq/commit/44a47236dd471b26bf6d66e53d2bfe76d6f839df))
* **hq:** migrate spatial workspace runtime ([7a9315d](https://github.com/0xPlayerOne/agent-hq/commit/7a9315d7b0886760257f5901c5f003bab3753a65))
* initialize Agent HQ frontend workspace ([86f307a](https://github.com/0xPlayerOne/agent-hq/commit/86f307a9fc7cecb1e2da9f35adb5483fa9d0e6b7))
* **platforms:** add desktop mobile shells and scene core ([8f86371](https://github.com/0xPlayerOne/agent-hq/commit/8f863716f1f21537b58b28565ae88963e6b344ef))
* **scene-editor:** restore perspective toolbar toggle ([4818a95](https://github.com/0xPlayerOne/agent-hq/commit/4818a95e532eef857f70335e88befdf5fcd8f445))


### Bug Fixes

* **hq:** align road and interior scene surfaces ([a908349](https://github.com/0xPlayerOne/agent-hq/commit/a908349715639754c2b6a44584a4bcc972e03cdb))
* **hq:** complete road sidewalk and wall finish ([7692127](https://github.com/0xPlayerOne/agent-hq/commit/7692127108c45a92e22016e18e14bd898de0042e))
* **hq:** extend cement frontage through designer view ([b385530](https://github.com/0xPlayerOne/agent-hq/commit/b385530f06c7eb553e1f7fbd2da94070f30b5df9))
* **hq:** frame full fence perimeter ([34ed51a](https://github.com/0xPlayerOne/agent-hq/commit/34ed51a3aa155af2c238a676b795df7e4e3b3dd4))
* **hq:** frame street frontage below workspace bar ([603f77f](https://github.com/0xPlayerOne/agent-hq/commit/603f77f70e7a6fd0374d8aa9c3eaf3c25bd062fd))
* **hq:** keep camera clear and close fence gate ([8c487a4](https://github.com/0xPlayerOne/agent-hq/commit/8c487a4dd1849f4d82396d6fe23cbb88b9243fc8))
* **hq:** keep camera switches in the live scene ([82d7900](https://github.com/0xPlayerOne/agent-hq/commit/82d7900649a0310a2c51584fca5cb07345062935))
* **hq:** raise exterior room walls ([1a6d40c](https://github.com/0xPlayerOne/agent-hq/commit/1a6d40c61f1028b6bc3e15e3898485d6bb4b5fe0))
* **hq:** render walls and save editor changes ([5f722ce](https://github.com/0xPlayerOne/agent-hq/commit/5f722cee50241b67117ea1f34e23d436b344a247))
* **hq:** restore centered scene framing and cement frontage ([502414a](https://github.com/0xPlayerOne/agent-hq/commit/502414a9d24c9e7d611a8db2ed0fd2361c6645cf))


### Performance

* add measurable HQ runtime and validation gates ([fa2e36e](https://github.com/0xPlayerOne/agent-hq/commit/fa2e36e7769af2cb57b353074e1caf704091b5e1))
* **assets:** serve HQ materials as WebP ([58033b0](https://github.com/0xPlayerOne/agent-hq/commit/58033b0a8e943556666fd108a263bcc51f90a83b))
* compress runtime character and landscape assets ([5d7e1fe](https://github.com/0xPlayerOne/agent-hq/commit/5d7e1fedca322e072d849893948a7e33c1da9b50))
* **hq:** reuse scene materials ([a060e84](https://github.com/0xPlayerOne/agent-hq/commit/a060e844ee147678f1e7fcc7464b48d90beccf6a))
* instrument HQ runtime and validation gates ([69466a3](https://github.com/0xPlayerOne/agent-hq/commit/69466a366024e7238282b917bcae5e889de976c2))
* optimize HQ scene foundation ([93fc2cb](https://github.com/0xPlayerOne/agent-hq/commit/93fc2cb25aa9fb30c86cbbd61a98a600c3acd0c5))
* **web:** lazy load home ambient pets ([dd0c761](https://github.com/0xPlayerOne/agent-hq/commit/dd0c761ce24044a9acf412999c4b13de52d5fa95))
* **web:** share grass perimeter and split UI imports ([76db328](https://github.com/0xPlayerOne/agent-hq/commit/76db32816d4ade7d330374143353948aec57e7e1))


### Maintenance

* **characters:** own character runtime and catalogs ([898a98e](https://github.com/0xPlayerOne/agent-hq/commit/898a98ecd6bed5bc5a83aa24fd2504f91641e63b))
* **deps:** update workspace dependencies ([20e115f](https://github.com/0xPlayerOne/agent-hq/commit/20e115f7498c0a37b96317750c1d5b80cf5ea352))
* **dev:** configure Portless development routing ([f1d3ef9](https://github.com/0xPlayerOne/agent-hq/commit/f1d3ef989de4915cb12afe2ba74dfffc48abf9ca))
* **hq:** promote scene editing controls ([b0ec54f](https://github.com/0xPlayerOne/agent-hq/commit/b0ec54fc8e2301d4738d146b2a2ca70d6112e51d))
* **interior:** combine room prop and model packages ([3a5a05b](https://github.com/0xPlayerOne/agent-hq/commit/3a5a05b09557c287968a8fcdf0900a9f9d195132))
* **pets:** own ambient animal assets and runtime ([4ca2a0a](https://github.com/0xPlayerOne/agent-hq/commit/4ca2a0a4b0e3a68c1f8d12f1ddd16d0de221eebc))
* remove generated web agent instructions ([0817c66](https://github.com/0xPlayerOne/agent-hq/commit/0817c669d2fd691dd1ce16f7e0de5429e517db57))
* remove legacy HQ surfaces and generated scaffolding ([1c53e5f](https://github.com/0xPlayerOne/agent-hq/commit/1c53e5f1f669474c1ed27e3fb34e5a41bbbedbc6))
* remove stale web agent instructions ([86c1131](https://github.com/0xPlayerOne/agent-hq/commit/86c113149bf5c048c5117fc929171f2173d1659b))
* rename scene field loader and document packages ([f3cff59](https://github.com/0xPlayerOne/agent-hq/commit/f3cff594c1be7978143e960c1a35dbe1a940bc92))
* **repo:** rename hq app to web ([e02870b](https://github.com/0xPlayerOne/agent-hq/commit/e02870b227bc5753df9bf033c27533e743902e92))
* **scenes:** combine HQ scene packages ([f997f5b](https://github.com/0xPlayerOne/agent-hq/commit/f997f5bd0603530400bf2ec74254a9290dc1013c))
* **web:** ignore generated Next type shim ([682b5a6](https://github.com/0xPlayerOne/agent-hq/commit/682b5a69a30783cdc1a65079d6fc32f79f9fa8ed))

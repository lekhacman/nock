'use strict'

const http = require('http')
const https = require('https')
const { URLSearchParams } = require('url')
const fs = require('fs')
const zlib = require('zlib')
const sinon = require('sinon')
const { expect } = require('chai')
const nock = require('..')
const got = require('./got_client')

require('./cleanup_after_each')()
require('./setup')

let globalCount
beforeEach(() => {
  globalCount = Object.keys(global).length
})
afterEach(() => {
  let leaks = Object.keys(global).splice(globalCount, Number.MAX_VALUE)
  if (leaks.length === 1 && leaks[0] === '_key') {
    leaks = []
  }
  expect(leaks).to.be.empty()
})

let server
afterEach(() => {
  if (server) {
    server.close()
    server = undefined
  }
})

it('when request port is different, use the alternate port', async () => {
  nock.restore()
  nock.recorder.clear()
  nock.recorder.rec(true)

  server = http.createServer((request, response) => response.end())
  await new Promise(resolve => server.listen(resolve))

  const { port } = server.address()
  expect(port).not.to.equal(80)

  await got.post(`http://localhost:${port}/`)

  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0]).to.include(`nock('http://localhost:${port}',`)
})

it('recording turns off nock interception (backward compatibility behavior)', () => {
  //  We ensure that there are no overrides.
  nock.restore()
  expect(nock.isActive()).to.be.false()
  //  We active the nock overriding - as it's done by merely loading nock.
  nock.activate()
  expect(nock.isActive()).to.be.true()
  //  We start recording.
  nock.recorder.rec()
  //  Nothing happens (nothing has been thrown) - which was the original behavior -
  //  and mocking has been deactivated.
  expect(nock.isActive()).to.be.false()
})

it('records', async () => {
  const gotRequest = sinon.spy()

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server = http.createServer((request, response) => {
    gotRequest()
    response.writeHead(200)
    response.end()
  })
  await new Promise(resolve => server.listen(resolve))
  const { port } = server.address()

  nock.recorder.rec(true)

  await got.post(`http://localhost:${port}`)

  expect(gotRequest).to.have.been.calledOnce()

  nock.restore()

  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0]).to.be.a('string')
  // TODO: Use chai-string?
  expect(
    recorded[0].startsWith(
      `\nnock('http://localhost:${port}', {"encodedQueryParams":true})\n  .post('/')`
    )
  ).to.be.true()
})

it('records objects', async () => {
  const gotRequest = sinon.spy()

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server = http.createServer((request, response) => {
    gotRequest()
    response.writeHead(200)
    response.end()
  })

  await new Promise(resolve => server.listen(resolve))

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  const requestBody = '0123455'
  const url = `http://localhost:${server.address().port}`
  await got.post(url, { body: requestBody })

  expect(gotRequest).to.have.been.calledOnce()
  nock.restore()
  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0]).to.include({
    scope: url,
    method: 'POST',
    body: requestBody,
  })
})

it('logs recorded objects', async () => {
  const gotRequest = sinon.spy()
  const loggingFn = sinon.spy()

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server = http.createServer((request, response) => {
    gotRequest()
    response.writeHead(200)
    response.end()
  })
  await new Promise(resolve => server.listen(resolve))
  const { port } = server.address()

  nock.recorder.rec({
    logging: loggingFn,
    output_objects: true,
  })

  await got.post(`http://localhost:${port}`)

  expect(gotRequest).to.have.been.calledOnce()
  expect(loggingFn).to.have.been.calledOnce()
  expect(
    loggingFn
      .getCall(0)
      .args[0].startsWith(
        '\n<<<<<<-- cut here -->>>>>>\n{\n  "scope": "http://localhost:'
      )
  ).to.be.true()
})

it('records objects and correctly stores JSON object in body', async () => {
  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server = http.createServer((request, response) => response.end())
  await new Promise(resolve => server.listen(resolve))
  const { port } = server.address()

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  const exampleBody = { foo: 123 }

  await got.post(`http://localhost:${port}/`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exampleBody),
  })

  nock.restore()
  const recorded = nock.recorder.play()
  nock.recorder.clear()
  nock.activate()

  expect(recorded).to.have.lengthOf(1)

  // TODO See https://github.com/nock/nock/issues/1229

  // This is the current behavior: store body as decoded JSON.
  expect(recorded[0]).to.deep.include({ body: exampleBody })

  // This is the desired behavior: store the body as encoded JSON. The second
  // test shows desired behavior: store body as encoded JSON so that JSON
  // strings can be correctly matched at runtime. Because headers are not
  // stored in the recorder output, it is impossible for the loader to
  // differentiate a stored JSON string from a non-JSON body.
  // expect(recorded[0]).to.include({ body: JSON.stringify(exampleBody) })
})

it('records and replays objects correctly', async () => {
  const exampleText = '<html><body>example</body></html>'

  server = http.createServer((request, response) => {
    switch (require('url').parse(request.url).pathname) {
      case '/':
        response.writeHead(302, { Location: '/abc' })
        break
      case '/abc':
        response.write(exampleText)
        break
    }
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  await new Promise(resolve => server.listen(resolve))

  const response1 = await got(`http://localhost:${server.address().port}`)
  expect(response1.body).to.equal(exampleText)

  nock.restore()
  const recorded = nock.recorder.play()
  nock.recorder.clear()
  nock.activate()

  expect(recorded).to.have.lengthOf(2)
  const nocks = nock.define(recorded)

  const response2 = await got(`http://localhost:${server.address().port}`)
  expect(response2.body).to.equal(exampleText)
  nocks.forEach(nock => nock.done())
})

it('records and replays correctly with filteringRequestBody', async () => {
  const responseBody = '<html><body>example</body></html>'
  server = http.createServer((request, response) => {
    response.write(responseBody)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  await new Promise(resolve => server.listen(resolve))

  const response1 = await got(`http://localhost:${server.address().port}`)
  expect(response1.body).to.equal(responseBody)
  expect(response1.headers).to.be.ok()

  nock.restore()
  const recorded = nock.recorder.play()
  nock.recorder.clear()
  nock.activate()

  expect(recorded).to.have.lengthOf(1)
  const onFilteringRequestBody = sinon.spy()
  const [definition] = recorded
  definition.filteringRequestBody = (body, aRecodedBody) => {
    onFilteringRequestBody()
    expect(body).to.equal(aRecodedBody)
    return body
  }
  const nocks = nock.define([definition])

  const response2 = await got(`http://localhost:${server.address().port}`)
  expect(response2.body).to.equal(responseBody)
  nocks.forEach(nock => nock.done())
  expect(onFilteringRequestBody).to.have.been.calledOnce()
})

// https://github.com/nock/nock/issues/29
it('http request without callback should not crash', done => {
  const serverFinished = sinon.spy()

  server = http.createServer((request, response) => {
    response.write('<html><body>example</body></html>')
    response.end()
    expect(serverFinished).to.have.been.calledOnce()
    done()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    nock.recorder.rec(true)
    http
      .request({
        host: 'localhost',
        port: server.address().port,
        method: 'GET',
        path: '/',
      })
      .end()
    nock.restore()
    serverFinished()
  })
})

it('checks that data is specified', () => {
  nock.restore()
  nock.recorder.clear()
  nock.recorder.rec(true)

  const req = http.request({
    method: 'POST',
    host: 'localhost',
    path: '/',
    port: '80',
    body: undefined,
  })

  expect(() => req.write()).to.throw(Error, 'Data was undefined.')
  req.abort()
})

it('when request body is json, it goes unstringified', async () => {
  server = http.createServer((request, response) => response.end())

  nock.restore()
  nock.recorder.clear()
  nock.recorder.rec(true)

  const payload = { a: 1, b: true }

  await new Promise(resolve => server.listen(resolve))
  const { port } = server.address()

  await got.post(`http://localhost:${port}/`, { body: JSON.stringify(payload) })

  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0]).to.include('.post(\'/\', {"a":1,"b":true})')
})

it('when request body is json, it goes unstringified in objects', async () => {
  server = http.createServer((request, response) => response.end())

  nock.restore()
  nock.recorder.clear()
  nock.recorder.rec({ dont_print: true, output_objects: true })

  const payload = { a: 1, b: true }

  await new Promise(resolve => server.listen(resolve))
  const { port } = server.address()

  await got.post(`http://localhost:${port}/`, { body: JSON.stringify(payload) })

  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0]).to.be.an('object')
  expect(recorded[0].body)
    .to.be.an('object')
    .and.deep.equal(payload)
})

it('records nonstandard ports', done => {
  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  const requestBody = 'ABCDEF'
  const responseBody = '012345'

  server = http.createServer((req, res) => {
    res.end(responseBody)
  })

  server.listen(() => {
    nock.recorder.rec({
      dont_print: true,
      output_objects: true,
    })

    const { port } = server.address()
    // Confidence check that we have a non-standard port.
    expect(port).to.be.greaterThan(8000)
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: '/',
      },
      res => {
        res.resume()
        res.once('end', () => {
          nock.restore()
          const recorded = nock.recorder.play()
          expect(recorded).to.have.lengthOf(1)
          expect(recorded[0])
            .to.be.an('object')
            .and.include({
              scope: `http://localhost:${port}`,
              method: 'GET',
              body: requestBody,
              status: 200,
              response: responseBody,
            })
          done()
        })
      }
    )

    req.end(requestBody)
  })
})

it('req.end accepts and calls a callback when recording', done => {
  const onEnd = sinon.spy()

  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    nock.recorder.rec({ dont_print: true })

    const req = http.request(
      {
        hostname: 'localhost',
        port: server.address().port,
        path: '/',
        method: 'GET',
      },
      res => {
        expect(onEnd).to.have.been.calledOnce()
        expect(res.statusCode).to.equal(200)
        res.on('end', () => {
          done()
        })
        res.resume()
      }
    )

    req.end(onEnd)
  })
})

it('rec() throws when reinvoked with already recorder requests', () => {
  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  nock.recorder.rec()
  expect(() => nock.recorder.rec()).to.throw(
    Error,
    'Nock recording already in progress'
  )
})

it('records https correctly', done => {
  const requestBody = '012345'
  const responseBody = '<html><body>example</body></html>'

  server = https.createServer(
    {
      key: fs.readFileSync('tests/ssl/ca.key'),
      cert: fs.readFileSync('tests/ssl/ca.crt'),
    },
    (request, response) => {
      response.write(responseBody)
      response.end()
    }
  )

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  server.listen(() => {
    const { port } = server.address()
    https
      .request(
        {
          method: 'POST',
          host: 'localhost',
          port,
          path: '/',
          rejectUnauthorized: false,
        },
        res => {
          res.resume()
          res.once('end', () => {
            nock.restore()
            const recorded = nock.recorder.play()
            expect(recorded).to.have.lengthOf(1)
            expect(recorded[0])
              .to.be.an('object')
              .and.to.include({
                scope: `https://localhost:${port}`,
                method: 'POST',
                body: requestBody,
                status: 200,
                response: responseBody,
              })
            done()
          })
        }
      )
      .end(requestBody)
  })
})

it('records request headers correctly as an object', done => {
  server = http.createServer((request, response) => response.end())

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    nock.recorder.rec({
      dont_print: true,
      output_objects: true,
      enable_reqheaders_recording: true,
    })

    const { port } = server.address()
    http
      .request(
        {
          hostname: 'localhost',
          port,
          path: '/',
          method: 'GET',
          auth: 'foo:bar',
        },
        res => {
          res.resume()
          res.once('end', () => {
            nock.restore()
            const recorded = nock.recorder.play()
            expect(recorded).to.have.lengthOf(1)
            expect(recorded[0])
              .to.be.an('object')
              .and.deep.include({
                reqheaders: {
                  host: `localhost:${port}`,
                  authorization: `Basic ${Buffer.from('foo:bar').toString(
                    'base64'
                  )}`,
                },
              })
            done()
          })
        }
      )
      .end()
  })
})

it('records request headers correctly when not outputting objects', async () => {
  const gotRequest = sinon.spy()

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server = http.createServer((request, response) => {
    gotRequest()
    response.writeHead(200)
    response.end()
  })
  await new Promise(resolve => server.listen(resolve))
  const { port } = server.address()

  nock.recorder.rec({
    dont_print: true,
    enable_reqheaders_recording: true,
  })

  await got.post(`http://localhost:${port}`, { headers: { 'X-Foo': 'bar' } })
  expect(gotRequest).to.have.been.calledOnce()

  nock.restore()

  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0])
    .to.be.a('string')
    .and.include('  .matchHeader("x-foo", "bar")')
})

it('records and replays gzipped nocks correctly', async () => {
  const exampleText = '<html><body>example</body></html>'

  server = http.createServer((request, response) => {
    zlib.gzip(exampleText, (err, result) => {
      expect(err).to.be.null()
      response.writeHead(200, { 'content-encoding': 'gzip' })
      response.end(result)
    })
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  await new Promise(resolve => server.listen(resolve))

  const { port } = server.address()
  const response1 = await got(`http://localhost:${port}`)
  expect(response1.body).to.equal(exampleText)
  expect(response1.headers).to.include({ 'content-encoding': 'gzip' })

  nock.restore()
  const recorded = nock.recorder.play()
  nock.recorder.clear()
  nock.activate()

  expect(recorded).to.have.lengthOf(1)
  const nocks = nock.define(recorded)

  const response2 = await got(`http://localhost:${port}`)
  expect(response2.body).to.equal(exampleText)
  expect(response2.headers).to.include({ 'content-encoding': 'gzip' })

  nocks.forEach(nock => nock.done())
})

it('records and replays the response body', async () => {
  const exampleBody = '<html><body>example</body></html>'

  server = http.createServer((request, response) => {
    switch (require('url').parse(request.url).pathname) {
      case '/':
        response.writeHead(302, { Location: '/abc' })
        break
      case '/abc':
        response.write(exampleBody)
        break
    }
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  await new Promise(resolve => server.listen(resolve))

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  const { port } = server.address()

  const response1 = await got(`http://localhost:${port}`)
  expect(response1.body).to.equal(exampleBody)

  nock.restore()
  const recorded = nock.recorder.play()
  nock.recorder.clear()
  nock.activate()

  // Two requests, on account of the redirect.
  expect(recorded).to.have.lengthOf(2)
  const nocks = nock.define(recorded)

  const response2 = await got(`http://localhost:${port}`)
  expect(response2.body).to.equal(exampleBody)
  nocks.forEach(nock => nock.done())
})

it('when encoding is set during recording, body is still recorded correctly', done => {
  const responseBody = '<html><body>example</body></html>'

  server = http.createServer((request, response) => {
    response.write(responseBody)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    nock.recorder.rec({
      dont_print: true,
      output_objects: true,
    })

    const { port } = server.address()

    const req = http.request(
      { host: 'localhost', port, path: '/', method: 'POST' },
      res => {
        res.setEncoding('hex')

        const hexChunks = []
        res.on('data', data => {
          hexChunks.push(data)
        })

        res.on('end', () => {
          nock.restore()
          const recorded = nock.recorder.play()
          nock.recorder.clear()
          nock.activate()

          // Confidence check: we're getting hex.
          expect(hexChunks.join('')).to.equal(
            Buffer.from(responseBody, 'utf8').toString('hex')
          )

          // Assert: we're recording utf-8.
          expect(recorded).to.have.lengthOf(1)
          expect(recorded[0]).to.include({ response: responseBody })

          done()
        })
      }
    )
    req.end()
  })
})

it("doesn't record request headers by default", done => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    nock.recorder.rec({
      dont_print: true,
      output_objects: true,
    })

    http
      .request(
        {
          hostname: 'localhost',
          port: server.address().port,
          path: '/',
          method: 'GET',
          auth: 'foo:bar',
        },
        res => {
          res.resume()
          res.once('end', () => {
            nock.restore()
            const recorded = nock.recorder.play()
            expect(recorded).to.have.lengthOf(1)
            expect(recorded[0]).to.be.an('object')
            expect(recorded[0].reqheaders).to.be.undefined()
            done()
          })
        }
      )
      .end()
  })
})

it('will call a custom logging function', done => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  // This also tests that use_separator is on by default.
  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    const loggingFn = sinon.spy()
    nock.recorder.rec({ logging: loggingFn })

    http
      .request(
        {
          hostname: 'localhost',
          port: server.address().port,
          path: '/',
          method: 'GET',
          auth: 'foo:bar',
        },
        res => {
          res.resume()
          res.once('end', () => {
            nock.restore()

            expect(loggingFn).to.have.been.calledOnce()
            expect(loggingFn.getCall(0).args[0]).to.be.a('string')
            done()
          })
        }
      )
      .end()
  })
})

it('use_separator:false is respected', done => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    const loggingFn = sinon.spy()
    nock.recorder.rec({
      logging: loggingFn,
      output_objects: true,
      use_separator: false,
    })

    http
      .request(
        {
          hostname: 'localhost',
          port: server.address().port,
          path: '/',
          method: 'GET',
          auth: 'foo:bar',
        },
        res => {
          res.resume()
          res.once('end', () => {
            nock.restore()
            expect(loggingFn).to.have.been.calledOnce()
            // This is still an object, because the "cut here" strings have not
            // been appended.
            expect(loggingFn.getCall(0).args[0]).to.be.an('object')
            done()
          })
        }
      )
      .end()
  })
})

it('records request headers except user-agent if enable_reqheaders_recording is set to true', done => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    nock.recorder.rec({
      dont_print: true,
      output_objects: true,
      enable_reqheaders_recording: true,
    })

    http
      .request(
        {
          hostname: 'localhost',
          port: server.address().port,
          path: '/',
          method: 'GET',
          auth: 'foo:bar',
        },
        res => {
          res.resume()
          res.once('end', () => {
            nock.restore()
            const recorded = nock.recorder.play()
            expect(recorded).to.have.lengthOf(1)
            expect(recorded[0]).to.be.an('object')
            expect(recorded[0].reqheaders).to.be.an('object')
            expect(recorded[0].reqheaders['user-agent']).to.be.undefined()
            done()
          })
        }
      )
      .end()
  })
})

it('records query parameters', async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  await new Promise(resolve => server.listen(resolve))

  nock.recorder.rec({
    dont_print: true,
    output_objects: true,
  })

  await got(`http://localhost:${server.address().port}`, {
    query: { q: 'test search' },
  })

  nock.restore()
  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0]).to.include({ path: '/?q=test+search' })
})

it('encodes the query parameters when not outputting objects', async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  await new Promise(resolve => server.listen(resolve))

  nock.recorder.rec({
    dont_print: true,
    output_objects: false,
  })

  await got(`http://localhost:${server.address().port}`, {
    query: { q: 'test search++' },
  })

  nock.restore()
  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0]).to.include('test%20search%2B%2B')
})

// https://github.com/nock/nock/issues/193
it('works with clients listening for readable', done => {
  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  const requestBody = 'ABCDEF'
  const responseBody = '012345'

  server = http.createServer((req, res) => {
    res.end(responseBody)
  })

  server.listen(() => {
    nock.recorder.rec({ dont_print: true, output_objects: true })

    const { port } = server.address()
    http
      .request(
        {
          host: 'localhost',
          port,
          path: '/',
        },
        res => {
          let readableCount = 0
          let chunkCount = 0

          res.on('readable', () => {
            ++readableCount
            let chunk
            while ((chunk = res.read()) !== null) {
              expect(chunk.toString()).to.equal(responseBody)
              ++chunkCount
            }
          })

          res.once('end', () => {
            expect(readableCount).to.equal(1)
            expect(chunkCount).to.equal(1)

            const recorded = nock.recorder.play()
            expect(recorded).to.have.lengthOf(1)
            expect(recorded[0])
              .to.be.an('object')
              .and.include({
                scope: `http://localhost:${port}`,
                method: 'GET',
                body: requestBody,
                status: 200,
                response: responseBody,
              })
            done()
          })
        }
      )
      .end(requestBody)
  })
})

it('outputs query string parameters using query()', async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  await new Promise(resolve => server.listen(resolve))

  nock.recorder.rec(true)

  await got(`http://localhost:${server.address().port}/`, {
    query: { param1: 1, param2: 2 },
  })

  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0])
    .to.be.a('string')
    .and.include(`.query({"param1":"1","param2":"2"})`)
})

it('outputs query string arrays correctly', async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  await new Promise(resolve => server.listen(resolve))

  nock.recorder.rec(true)

  await got(`http://localhost:${server.address().port}/`, {
    query: new URLSearchParams([
      ['foo', 'bar'],
      ['foo', 'baz'],
    ]),
  })

  const recorded = nock.recorder.play()
  expect(recorded).to.have.lengthOf(1)
  expect(recorded[0])
    .to.be.a('string')
    .and.include(`.query({"foo":["bar","baz"]})`)
})

it('removes query params from the path and puts them in query()', done => {
  server = http.createServer((request, response) => {
    response.writeHead(200)
    response.end()
  })

  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  server.listen(() => {
    nock.recorder.rec(true)
    http
      .request(
        {
          method: 'POST',
          host: 'localhost',
          port: server.address().port,
          path: '/?param1=1&param2=2',
        },
        res => {
          res.resume()
          res.once('end', () => {
            const recorded = nock.recorder.play()
            expect(recorded).to.have.lengthOf(1)
            expect(recorded[0])
              .to.be.a('string')
              .and.include(`nock('http://localhost:${server.address().port}',`)
              .and.include(`.query({"param1":"1","param2":"2"})`)
            done()
          })
        }
      )
      .end('ABCDEF')
  })
})

it('respects http.request() consumers', done => {
  server = http.createServer((req, res) => {
    res.write('foo')
    setTimeout(() => {
      res.end('bar')
    }, 25)
  })

  server.listen(() => {
    nock.restore()
    nock.recorder.clear()
    nock.recorder.rec({
      dont_print: true,
      output_objects: true,
    })

    const req = http.request(
      {
        host: 'localhost',
        port: server.address().port,
        path: '/',
      },
      res => {
        let buffer = Buffer.from('')

        setTimeout(() => {
          res
            .on('data', data => {
              buffer = Buffer.concat([buffer, data])
            })
            .on('end', () => {
              nock.restore()
              expect(buffer.toString()).to.equal('foobar')
              done()
            })
        })
      },
      50
    )

    req.end()
  })
})

it('records and replays binary response correctly', done => {
  nock.restore()
  nock.recorder.clear()
  expect(nock.recorder.play()).to.be.empty()

  nock.recorder.rec({
    output_objects: true,
    dont_print: true,
  })

  const transparentGifHex =
    '47494638396101000100800000000000ffffff21f90401000000002c000000000100010000020144003b'
  const transparentGifBuffer = Buffer.from(transparentGifHex, 'hex')

  server = http.createServer((request, response) => {
    response.writeHead(201, {
      'Content-Type': 'image/gif',
      'Content-Length': transparentGifBuffer.length,
    })
    response.write(transparentGifBuffer, 'binary')
    response.end()
  })

  server.listen(() => {
    const options = {
      method: 'PUT',
      host: 'localhost',
      port: server.address().port,
      path: '/clear.gif',
      headers: {
        'Content-Type': 'image/gif',
        'Content-Length': transparentGifBuffer.length,
      },
    }

    const postRequest1 = http.request(options, response => {
      const data = []

      response.on('data', chunk => {
        data.push(chunk)
      })

      response.on('end', () => {
        expect(Buffer.concat(data).toString('hex')).to.equal(transparentGifHex)

        const recordedFixtures = nock.recorder.play()

        server.close(error => {
          server = undefined
          expect(error).to.be.undefined()

          nock.restore()
          nock.activate()
          nock.define(recordedFixtures)

          // Send same post request again.
          const postRequest2 = http.request(options, response => {
            const data = []

            response.on('data', chunk => {
              data.push(chunk)
            })

            response.on('end', () => {
              expect(Buffer.concat(data).toString('hex')).to.equal(
                transparentGifHex
              )
              done()
            })
          })

          postRequest2.write(transparentGifBuffer)
          postRequest2.end()
        })
      })
    })

    postRequest1.write(transparentGifBuffer)
    postRequest1.end()
  })
})

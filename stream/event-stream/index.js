//filter will reemit the data if cb(err,pass) pass is truthy

// reduce is more tricky
// maybe we want to group the reductions or emit progress updates occasionally
// the most basic reduce just emits one 'data' event after it has recieved 'end'

var Stream = require('stream').Stream
  , es = exports
  // [tip] https://github.com/dominictarr/through
  , through = require('through')
  // [tip] Easy way to create a Readable Stream
  // [tip] https://github.com/dominictarr/from
  , from = require('from')
  // [tip] Takes a writable stream and a readable stream and makes them appear as a readable writable stream.
  // [tip] It is assumed that the two streams are connected to each other in some way.
  // [tip] https://github.com/Raynos/duplexer
  , duplex = require('duplexer')
  // [tip] https://github.com/dominictarr/map-stream
  , map = require('map-stream')
  // [tip] https://github.com/dominictarr/pause-stream
  , pause = require('pause-stream')
  // [tip] https://github.com/dominictarr/split
  , split = require('split')
  // [tip] https://github.com/dominictarr/stream-combiner
  , pipeline = require('stream-combiner')
  , immediately = global.setImmediate || process.nextTick;

es.Stream = Stream //re-export Stream from core
es.through = through
es.from = from
es.duplex = duplex
es.map = map
es.pause = pause
es.split = split
es.pipeline = es.connect = es.pipe = pipeline
// merge / concat
//
// combine multiple streams into a single stream.
// will emit end only once
// [tip]  ponit：只会触发一次end事件
es.concat = //actually this should be called concat
es.merge = function (/*streams...*/) {
  var toMerge = [].slice.call(arguments)
  // [tip]  处理多种传参
  if (toMerge.length === 1 && (toMerge[0] instanceof Array)) {
    toMerge = toMerge[0] //handle array as arguments object
  }
  var stream = new Stream()
  stream.setMaxListeners(0) // allow adding more than 11 streams
  var endCount = 0
  stream.writable = stream.readable = true

  if (toMerge.length) {
    toMerge.forEach(function (e) {
      // [tip]  默认，当源可读流触发 'end' 事件时，目标流也会调用 stream.end() 方法从而结束写入
      // [tip]  为目标可写流绑定了多个可读流
      // [tip]  因此需要在某个可读流结束时设置end选项应该为false，以保持目标流打开
      e.pipe(stream, {end: false})
      var ended = false
      // [tip]  为每个可读流添加end监听，通过endCount计数
      // [tip]  当endCount与当前流数量相同时，全部写入完成，触发stream的end事件
      e.on('end', function () {
        if(ended) return
        ended = true
        endCount ++
        if(endCount == toMerge.length)
          stream.emit('end')
      })
    })
  // [tip]  流数量为空，触发end事件
  } else {
    process.nextTick(function () {
      stream.emit('end')
    })
  }
  
  // [doubt]  重写stream流写入方法
  stream.write = function (data) {
    this.emit('data', data)
  }

  // [tip]  销毁toMerge数组中所有流
  stream.destroy = function () {
    toMerge.forEach(function (e) {
      if(e.destroy) e.destroy()
    })
  }
  return stream
}


// writable stream, collects all events into an array
// and calls back when 'end' occurs
// mainly I'm using this to test the other functions

es.writeArray = function (done) {
  if ('function' !== typeof done)
    throw new Error('function writeArray (done): done must be function')

  var a = new Stream ()
    , array = [], isDone = false
  a.write = function (l) {
    array.push(l)
  }
  a.end = function () {
    isDone = true
    done(null, array)
  }
  a.writable = true
  a.readable = false
  a.destroy = function () {
    a.writable = a.readable = false
    if(isDone) return
    done(new Error('destroyed before end'), array)
  }
  return a
}

//return a Stream that reads the properties of an object
//respecting pause() and resume()

es.readArray = function (array) {
  var stream = new Stream()
    , i = 0
    , paused = false
    , ended = false

  // [tip]  可读流
  stream.readable = true
  stream.writable = false

  if(!Array.isArray(array))
    throw new Error('event-stream.read expects an array')

  // [tip]  读取
  stream.resume = function () {
    if(ended) return
    paused = false
    var l = array.length
    // [tip]  每次读取数组中的一个元素，并触发data事件
    // [tip]  需要保证流状态：未暂停 且 未结束
    while(i < l && !paused && !ended) {
      stream.emit('data', array[i++])
    }
    // [tip]  流读取结束
    if(i == l && !ended)
      ended = true, stream.readable = false, stream.emit('end')
  }

  // [tip]  可读流创建后，在下一次事件循环时，开始读取
  process.nextTick(stream.resume)

  // [tip]  暂停
  stream.pause = function () {
     paused = true
  }

  // [tip]  销毁，end
  stream.destroy = function () {
    ended = true
    stream.emit('close')
  }
  return stream
}

//
// readable (asyncFunction)
// return a stream that calls an async function while the stream is not paused.
//
// the function must take: (count, callback) {...
//

es.readable =
function (func, continueOnError) {
  var stream = new Stream()
    , i = 0
    , paused = false
    , ended = false
    , reading = false

  stream.readable = true
  stream.writable = false

  if('function' !== typeof func)
    throw new Error('event-stream.readable expects async function')

  stream.on('end', function () { ended = true })

  function get (err, data) {

    if(err) {
      stream.emit('error', err)
      // [tip] 出错是否继续
      if(!continueOnError) stream.emit('end')
    } else if (arguments.length > 1)
      // [tip] 如果get函数包含data参数，则作为chunk触发data事件
      stream.emit('data', data)

    immediately(function () {
      // [tip] 读取结束、暂停读取、正在读取时，不进行下一次读取
      if(ended || paused || reading) return
      try {
        reading = true
        // [tip] 匿名函数function (){}会被传入你自己定义的readable - asyncFunction中作为 callback
        // [tip] 因此需要你手动调用，否则不会继续读取
        // [tip] readable用法参见https://github.com/dominictarr/event-stream#readable-asyncfunction
        func.call(stream, i++, function () {
          reading = false
          // [tip] 将callback中的arguments作为参数传给get函数
          // [tip] 根据定义，因此cb的第一个参数为err，第二个参数为data
          get.apply(null, arguments)
        })
      } catch (err) {
        stream.emit('error', err)
      }
    })
  }

  // [tip] 恢复重新读取
  stream.resume = function () {
    paused = false
    // [tip] 重新开启读取polling
    get()
  }
  process.nextTick(get)
  stream.pause = function () {
     paused = true
  }
  stream.destroy = function () {
    stream.emit('end')
    stream.emit('close')
    ended = true
  }
  return stream
}


//
// map sync
//

es.mapSync = function (sync) {
  return es.through(function write(data) {
    var mappedData
    try {
      // [tip] 同步(synchronized)方法，sync方法内部需要通过return返回数据
      // [tip] 异步版本则通过callback
      mappedData = sync(data)
    } catch (err) {
      return this.emit('error', err)
    }
    if (mappedData !== undefined)
      this.emit('data', mappedData)
  })
}

//
// log just print out what is coming through the stream, for debugging
//
// [tip] 类似于一个不做任何处理的管道，只是打印data
es.log = function (name) {
  return es.through(function (data) {
    var args = [].slice.call(arguments)
    if(name) console.error(name, data)
    else     console.error(data)
    this.emit('data', data)
  })
}


//
// child -- pipe through a child process
//

es.child = function (child) {

  return es.duplex(child.stdin, child.stdout)

}

//
// parse
//
// must be used after es.split() to ensure that each chunk represents a line
// source.pipe(es.split()).pipe(es.parse())
// [tip] 在parse之前最好先用split分行。主要是将原本的stream中的data分为一整块一整块的chunk
// [tip] 可以配置是否log err，便于调试
es.parse = function (options) {
  var emitError = !!(options ? options.error : false)
  return es.through(function (data) {
    var obj
    try {
      if(data) //ignore empty lines
        obj = JSON.parse(data.toString())
    } catch (err) {
      if (emitError)
        return this.emit('error', err)
      return console.error(err, 'attempting to parse:', data)
    }
    //ignore lines that where only whitespace.
    if(obj !== undefined)
      this.emit('data', obj)
  })
}
//
// stringify
//

es.stringify = function () {
  var Buffer = require('buffer').Buffer
  return es.mapSync(function (e){
    return JSON.stringify(Buffer.isBuffer(e) ? e.toString() : e) + '\n'
  })
}

//
// replace a string within a stream.
//
// warn: just concatenates the string and then does str.split().join().
// probably not optimal.
// for smallish responses, who cares?
// I need this for shadow-npm so it's only relatively small json files.

es.replace = function (from, to) {
  // [tip] es.split(from) ==> es.join(to) (0.0)
  return es.pipeline(es.split(from), es.join(to))
}

//
// join chunks with a joiner. just like Array#join
// also accepts a callback that is passed the chunks appended together
// this is still supported for legacy reasons.
//

es.join = function (str) {

  //legacy api
  if('function' === typeof str)
    return es.wait(str)

  var first = true
  return es.through(function (data) {
    // [tip] 开头不加str（第一个chunk前面不加str）
    // [tip] 其余的chunk前面都加上str
    if(!first)
      this.emit('data', str)
    first = false
    this.emit('data', data)
    return true
  })
}


//
// wait. callback when 'end' is emitted, with all chunks appended as string.
//

es.wait = function (callback) {
  // [tip] 用数组保存所有chunk
  var arr = []
  return es.through(function (data) { arr.push(data) },
    function () {
      // [tip] buffer和string分开处理
      var body = Buffer.isBuffer(arr[0]) ? Buffer.concat(arr)
        : arr.join('')
      // [tip] 全部拼接完成触发data事件
      this.emit('data', body)
      this.emit('end')
      if(callback) callback(null, body)
    })
}

// [tip] 废弃
es.pipeable = function () {
  throw new Error('[EVENT-STREAM] es.pipeable is deprecated')
}

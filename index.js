var path = require('path');
var fs = require('fs');
var EOL = require('os').EOL;

var through = require('through2');
var gutil = require('gulp-util');
var glob = require('glob');
var minimatch = require('minimatch');
var when = require('when');
var es = require('event-stream');
var Readable = require('stream').Readable;
var gulpConcat = require('gulp-concat');
var _ = require('lodash');

module.exports = function (options) {
  options = options || {};
  var startReg = /<!--\s*build:(\w+)(?:\(([^\)]+?)\))?\s+(\/?([^\s]+?))?\s*-->/gim;
  var endReg = /<!--\s*endbuild\s*-->/gim;
  var jsReg = /<\s*script\s+.*?src\s*=\s*("|')((?:[^\1]|\\\1)+?)\1.*?><\s*\/\s*script\s*>/gi;
  var cssReg = /<\s*link\s+.*?href\s*=\s*("|')((?:[^\1]|\\\1)+?)\1.*?>/gi;
  var startCondReg = /<!--\[[^\]]+\]>/gim;
  var endCondReg = /<!\[endif\]-->/gim;
  var basePath, mainPath, mainName, alternatePath;

  function getPath (name) {
    var filePath = path.join(path.relative(basePath, mainPath), name);
    var isStatic = name.split('.').pop() === 'js' || name.split('.').pop() === 'css';

    if (options.outputRelativePath && isStatic) {
      filePath = options.outputRelativePath + name;
    }
    return filePath;
  }

  function createFile (name, content) {
    return new gutil.File({
      path: getPath(name),
      contents: new Buffer(content)
    })
  }

  function getBlockType (content) {
    return !cssReg.test(content) ? 'js' : 'css';
  }

  function readStream (streamCtor, callback) {
    var files = [];
    var deferred = when.defer();

    var stream = streamCtor();
    stream.on('data', function (file) {
      if (file.isStream()) {
        this.emit('error', gutil.PluginError('gulp-usemin', 'Streams in assets are not supported!'));
      }

      file.base = path.resolve(file.base);
      file.path = path.resolve(file.path);
      files.push(file);
    });

    stream.on('end', function () {
      if (options.debugStreamFiles) {
        console.log('asssets:\n', files.map(function (f) {
          return f.base + ' :: ' + f.path;
        }).join('\n '));
      }
      deferred.resolve(files);
    });

    return deferred.promise;
  }

  function produceMatcher (fileArray) {
    var allFiles = fileArray.map(function (file) {
      return file.path;
    });

    var filesByPath = fileArray.reduce(function (obj, file) {
      obj[file.path] = file;
      return obj;
    }, {});

    var notMatched = allFiles.slice(); // clone

    return {
      matching: function (patterns) {
        function doMatch (pattern) {
          return minimatch.match(allFiles, pattern);
        }

        var incs = patterns.inc.map(doMatch);
        var excs = patterns.exc.map(doMatch);

        var matched = _.difference(_.union.apply(null, incs), _.union.apply(null, excs));

        // filter array
        notMatched = notMatched.filter(function (i) {
          return matched.indexOf(i) < 0;
        });

        return matched.map(function (path) {
          return filesByPath[path];
        });
      },

      notMatched: function () {
        return notMatched.map(function (path) {
          return filesByPath[path];
        });
      }
    }
  }

  function getFiles (content, reg, alternatePath, matcherPromise) {
    var paths = [];
    var promises = [];
    var files = [];
    var i, l;

    var arrayDetect = /^\[.*\]$/;
    var arrayParse = /'((?:[^']|\\')*[^'\\])'(?:\s*,\s*)?/g;

    content
      .replace(startCondReg, '')
      .replace(endCondReg, '')
      .replace(/<!--(?:(?:.|\r|\n)*?)-->/gim, '')
      .replace(reg, function (a, quote, pathPattern) {
        var patterns;

        var arrayDetected = pathPattern.match(arrayDetect);
        if (arrayDetected) {
          patterns = [];
          pathPattern.replace(arrayParse, function (a, pattern) {
            patterns.push(pattern);
          });
        }
        else {
          patterns = [pathPattern];
        }

        var inc = [],
            exc = [];

        _.each(patterns, function (pattern) {
          var isExc = false;
          if (pattern[0] === '!') {
            isExc = true;
            pattern = pattern.slice(1);
          }

          var filePath = path.resolve(path.join(alternatePath || options.path || mainPath, pattern));
          if (options.assetsDir) {
            filePath = path.resolve(path.join(options.assetsDir, path.relative(basePath, filePath)));
          }

          (isExc ? exc : inc).push(filePath);
        });
        paths.push({inc: inc, exc: exc, src: pathPattern});
      });

    if (!matcherPromise) {
      function globSync (pattern) {
        return glob.sync(pattern);
      }

      // read files from filesystem
      for (i = 0, l = paths.length; i < l; ++i) {
        var incs = paths[i].inc.map(globSync);
        var excs = paths[i].exc.map(globSync);
        var filepaths = _.difference(_.union.apply(null, incs), _.union.apply(null, excs));
        if (filepaths[0] === undefined) {
          throw new gutil.PluginError('gulp-usemin', 'Path ' + paths[i] + ' not found!');
        }
        promises.push.apply(promises, filepaths.map(function (filepath) {
          var fileDeferred = when.defer();
          fs.readFile(filepath, function (err, data) {
            if (err) {
              throw err;
            }
            fileDeferred.resolve(new gutil.File({
              path: filepath,
              contents: data
            }));
          });
          return fileDeferred.promise;
        }));
      }
      return when.all(promises);
    }
    else {
      // read files from stream
      for (i = 0, l = paths.length; i < l; ++i) {
        var matching = matcherPromise.matching(paths[i]);
        if (matching[0] === undefined) {
          throw new gutil.PluginError('gulp-usemin', 'Pattern ' + paths[i].src + ' not in stream!');
        }
        files.push.apply(files, matching);
      }
      return when.resolve(files);
    }
  }

  function concatThrough (name) {
    return gulpConcat(name);
  }

  function wrapLazypipe (lazypipe) {
    return function (stream, concat) {
      if (!_.isUndefined(concat)) {
        return stream
          .pipe(concat)
          .pipe(lazypipe());
      }
      else {
        return stream
          .pipe(lazypipe());
      }
    };
  }

  function processTask (pipeline, name, files) {
    if (pipeline === null) {
      return null;
    }

    var tip = new Readable({objectMode: true});

    tip._read = function () {
      if (files.length > 0) {
        var file = files.shift();
        this.push(file);
      }
      else {
        this.push(null);
      }
    };

    var concatTask = name ? concatThrough(name) : undefined;

    if (typeof pipeline === 'function') {
      // lazypipe support
      if (typeof pipeline.pipe === 'function') {
        return wrapLazypipe(pipeline)(tip, concatTask);
      }
      return pipeline(tip, concatTask);
    }
    else if (name) {
      return tip.pipe(concatTask);
    }
    else {
      return tip;
    }
  }

  function process (name, files, pipelineId) {
    var pipeline = options[pipelineId];
    if (typeof pipeline === 'undefined') {
      pipeline = [];
    }

    return processTask(pipeline, name, files);
  }

  function processHtml (content, matcherProducer) {
    var html = [];
    var sections = content.split(endReg);
    var promise = when.resolve();

    var streams = [];
    for (var i = 0, l = sections.length; i < l; ++i) {
      if (sections[i].match(startReg)) {
        var section = sections[i].split(startReg);
        alternatePath = section[2];

        (function (section) {
          promise = promise
            .then(function () {
              html.push(section[0]);
            });
        }(section));

        var startCondLine = section[5].match(startCondReg);
        var endCondLine = section[5].match(endCondReg);
        if (startCondLine && endCondLine) {
          (function (startCondLine) {
            promise = promise.then(function () {
              html.push(startCondLine[0]);
            });
          }(startCondLine))
        }

        if (section[1] !== 'remove') {

          (function (section, alternatePath) {
            var type = getBlockType(section[5]);
            promise = promise
              .then(matcherProducer)
              .then(function (matcher) {
                return getFiles(section[5], type === 'js' ? jsReg : cssReg, alternatePath, matcher)
              })
              .then(function (files) {
                var name = section[4];

                streams.push(process(name, files, section[1]));
                var filePaths = name ? [section[3]] : files.map(function (f) {
                  return '/' + path.relative(f.base, f.path).split(path.sep).join('/');
                });
                filePaths
                  .map(function (path) {
                    return getPath(path);
                  })
                  .forEach(function (filePath) {
                    if (type === 'js') {
                      html.push('<script src="' + filePath + '"></script>');
                    } else {
                      html.push('<link rel="stylesheet" href="' + filePath + '"/>');
                    }
                  });
              });
          }(section, alternatePath));
        }

        if (startCondLine && endCondLine) {
          (function (endCondLine) {
            promise = promise.then(function () {
              html.push(endCondLine[0]);
            });
          }(endCondLine));
        }
      }
      else {
        (function (section) {
          promise = promise.then(function () {
            html.push(section);
          });
        }(sections[i]))
      }
    }

    return promise.then(function () {
      streams.push(process(mainName, [createFile(mainName, html.join(''))], 'html'));
      return es.merge.apply(es, streams.filter(function (stream) {
        return stream !== null;
      }));
    });
  }

  var matcherPromise, matcherProducer;

  if (options.assetsStream) {
    matcherPromise = readStream(options.assetsStream)
      .then(function (filesList) {
        return produceMatcher(filesList);
      });
    matcherProducer = function () {
      return matcherPromise;
    }
  }

  return through.obj(function (file, enc, callback) {
    if (file.isNull()) {
      this.push(file); // Do nothing if no contents
      callback();
    }
    else if (file.isStream()) {
      this.emit('error', new gutil.PluginError('gulp-usemin', 'Streams are not supported!'));
      callback();
    }
    else {
      basePath = file.base;
      mainPath = path.dirname(file.path);
      mainName = path.basename(file.path);

      var push = this.push.bind(this);

      processHtml(String(file.contents), matcherProducer)
        .then(function (stream) {
          stream.on('data', function (file) {
            push(file);
          });

          stream.on('end', function () {
            callback();
          })
        });
    }
  }, function (callback) {
    // push not processed files down the stream
    if (options.other && matcherPromise) {
      var push = this.push.bind(this);
      matcherPromise.then(function (filesMatcher) {
        var rest = filesMatcher.notMatched();
        var stream = processTask(options.other, options.othersName, rest);
        if (stream === null) {
          callback();
          return;
        }

        stream.on('data', function (file) {
          push(file);
        });

        stream.on('end', function () {
          callback();
        })
      });
    }
    else {
      callback();
    }
  });
};

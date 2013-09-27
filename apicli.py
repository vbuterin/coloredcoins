#! /usr/bin/python
import os,sys,urllib

req = 'curl "http://localhost:3000/' + sys.argv[1] + '?'

rest = { x[:x.find('=')] : x[x.find('=')+1:] for x in sys.argv[2:] }

req += urllib.urlencode(rest) + '"'

print req

print os.popen(req).read()

